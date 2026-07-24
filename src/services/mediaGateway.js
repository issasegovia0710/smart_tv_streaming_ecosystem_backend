import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { Readable } from 'node:stream';

import { env } from '../config/env.js';
import { HttpError } from '../utils/httpError.js';

const TOKEN_TTL_MS = 20 * 60 * 1000;
const MAX_REDIRECTS = 5;
const MANIFEST_LIMIT_BYTES = 2 * 1024 * 1024;
const VALIDATION_TIMEOUT_MS = 7000;
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (SMART-TV; LINUX; Tizen 5.5) AppleWebKit/538.1 SamsungBrowser/2.1 TV Safari/538.1';

function isPrivateIpv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(Number.isNaN)) return true;
  const [a, b] = parts;
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || a >= 224
  );
}

function isPrivateIpv6(address) {
  const value = address.toLowerCase();
  return (
    value === '::' || value === '::1' || value.startsWith('fc') ||
    value.startsWith('fd') || value.startsWith('fe8') || value.startsWith('fe9') ||
    value.startsWith('fea') || value.startsWith('feb') ||
    value.startsWith('::ffff:127.') || value.startsWith('::ffff:10.') ||
    value.startsWith('::ffff:192.168.')
  );
}

function isPrivateAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return isPrivateIpv4(address);
  if (family === 6) return isPrivateIpv6(address);
  return true;
}

export async function assertPublicMediaUrl(rawUrl) {
  let url;
  try {
    url = rawUrl instanceof URL ? rawUrl : new URL(rawUrl);
  } catch {
    throw new HttpError(400, 'La URL multimedia no es válida.');
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new HttpError(400, 'Solo se permiten fuentes HTTP o HTTPS.');
  }

  const hostname = url.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.local')) {
    throw new HttpError(400, 'No se permiten direcciones locales.');
  }

  if (net.isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw new HttpError(400, 'No se permiten direcciones privadas.');
    return url;
  }

  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new HttpError(400, 'No fue posible resolver el dominio multimedia.');
  }

  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new HttpError(400, 'El dominio multimedia apunta a una dirección privada o inválida.');
  }

  return url;
}

function proxySecret() {
  const value = String(env.mediaProxySecret || env.dbPassword || '').trim();
  if (!value) throw new HttpError(500, 'Falta configurar MEDIA_PROXY_SECRET.');
  return crypto.createHash('sha256').update(value).digest();
}

function seal(payload) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', proxySecret(), iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((part) => part.toString('base64url')).join('.');
}

function unseal(token) {
  try {
    const [ivPart, tagPart, bodyPart] = String(token || '').split('.');
    if (!ivPart || !tagPart || !bodyPart) throw new Error('token incompleto');
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      proxySecret(),
      Buffer.from(ivPart, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(bodyPart, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
    const payload = JSON.parse(plaintext);
    if (!payload?.url || !payload?.expiresAt || Date.now() > payload.expiresAt) {
      throw new Error('token vencido');
    }
    return payload;
  } catch {
    throw new HttpError(403, 'La sesión multimedia no es válida o ya venció.');
  }
}

function requestOrigin(req) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
  const protocol = forwardedProto || req.protocol || 'https';
  const host = forwardedHost || req.get('host');
  return `${protocol}://${host}`;
}

function sanitizedHeaders(input = {}) {
  return {
    userAgent: String(input.userAgent || DEFAULT_USER_AGENT).slice(0, 500),
    referer: String(input.referer || '').slice(0, 1500),
    cookie: String(input.cookieHeader || input.cookie || '').slice(0, 6000),
  };
}

function tokenFor(url, headers, expiresAt) {
  return seal({
    version: 1,
    url,
    headers: sanitizedHeaders(headers),
    expiresAt: expiresAt || Date.now() + TOKEN_TTL_MS,
  });
}

function proxyUrl(req, url, headers, expiresAt) {
  return `${requestOrigin(req)}/api/v1/media/proxy/${tokenFor(url, headers, expiresAt)}`;
}

export function decorateResolvedMedia(req, resolution) {
  if (!resolution?.resolved || !resolution.playbackUrl) return resolution;
  if (resolution.resolvedType !== 'hls') {
    return { ...resolution, playbackMode: 'direct' };
  }

  const originalPlaybackUrl = resolution.playbackUrl;
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  return {
    ...resolution,
    originalPlaybackUrl,
    playbackUrl: proxyUrl(req, originalPlaybackUrl, resolution, expiresAt),
    playbackMode: 'proxy-hls',
    proxyExpiresAt: new Date(expiresAt).toISOString(),
    cookieHeader: '',
    userAgent: '',
    referer: '',
  };
}

function upstreamHeaders(input = {}, extra = {}) {
  const headers = {
    Accept: '*/*',
    'Accept-Language': 'es-MX,es;q=0.9,en;q=0.7',
    'User-Agent': input.userAgent || DEFAULT_USER_AGENT,
    ...extra,
  };
  if (input.referer) headers.Referer = input.referer;
  if (input.cookie) headers.Cookie = input.cookie;
  return headers;
}

async function fetchPublic(rawUrl, headers, options = {}) {
  let currentUrl = await assertPublicMediaUrl(rawUrl);
  const timeoutMs = Number(options.timeoutMs || VALIDATION_TIMEOUT_MS);

  for (let count = 0; count <= MAX_REDIRECTS; count += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetch(currentUrl, {
        method: options.method || 'GET',
        redirect: 'manual',
        headers,
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      if (error?.name === 'AbortError') throw new HttpError(408, 'La fuente multimedia tardó demasiado.');
      throw new HttpError(502, `No fue posible abrir la fuente multimedia: ${error.message}`);
    }
    clearTimeout(timer);

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location || count === MAX_REDIRECTS) {
        throw new HttpError(502, 'La fuente multimedia excedió el límite de redirecciones.');
      }
      currentUrl = await assertPublicMediaUrl(new URL(location, currentUrl));
      continue;
    }

    return { response, finalUrl: currentUrl.toString() };
  }

  throw new HttpError(502, 'No fue posible completar la solicitud multimedia.');
}

async function readTextLimited(response, limit = MANIFEST_LIMIT_BYTES) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > limit) throw new HttpError(413, 'El manifiesto multimedia es demasiado grande.');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > limit) throw new HttpError(413, 'El manifiesto multimedia es demasiado grande.');
  return buffer.toString('utf8');
}

function hlsUris(text, baseUrl) {
  const output = [];
  const add = (value) => {
    try {
      const resolved = new URL(String(value || '').trim(), baseUrl).toString();
      if (/^https?:\/\//i.test(resolved)) output.push(resolved);
    } catch {}
  };

  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (!line.startsWith('#')) add(line);
    line.replace(/URI=(?:"([^"]+)"|'([^']+)'|([^,\s]+))/gi, (_, a, b, c) => {
      add(a || b || c);
      return _;
    });
  }
  return [...new Set(output)];
}

async function readFirstChunk(response) {
  if (!response.body) return 0;
  const reader = response.body.getReader();
  try {
    const { value } = await reader.read();
    return value?.byteLength || 0;
  } finally {
    try { await reader.cancel(); } catch {}
  }
}

export async function validateMediaCandidate(candidate, options = {}) {
  const url = String(candidate?.url || '').trim();
  if (!url || /^(?:blob|data):/i.test(url)) {
    return { valid: false, reason: 'La URL es temporal o no es HTTP.' };
  }

  const headersData = sanitizedHeaders(candidate);
  const headers = upstreamHeaders(headersData);
  const timeoutMs = Number(options.timeoutMs || VALIDATION_TIMEOUT_MS);

  try {
    const first = await fetchPublic(url, headers, { timeoutMs });
    if (!first.response.ok) {
      return { valid: false, reason: `HTTP ${first.response.status}` };
    }

    const contentType = String(first.response.headers.get('content-type') || '').toLowerCase();
    const type = candidate.type || (
      contentType.includes('mpegurl') || /\.m3u8(?:$|[?#])/i.test(first.finalUrl) ? 'hls' :
      contentType.includes('dash+xml') || /\.mpd(?:$|[?#])/i.test(first.finalUrl) ? 'dash' :
      'mp4'
    );

    if (type === 'hls') {
      const manifest = await readTextLimited(first.response);
      if (!manifest.trimStart().startsWith('#EXTM3U')) {
        return { valid: false, reason: 'La respuesta no comienza con #EXTM3U.' };
      }

      const firstUris = hlsUris(manifest, first.finalUrl);
      if (!firstUris.length) {
        return { valid: false, reason: 'El manifiesto HLS no contiene variantes ni segmentos.' };
      }

      let childUrl = firstUris[0];
      let child = await fetchPublic(childUrl, upstreamHeaders(headersData, { Referer: headersData.referer || first.finalUrl }), { timeoutMs });
      if (!child.response.ok) {
        return { valid: false, reason: `La primera variante respondió HTTP ${child.response.status}.` };
      }

      const childType = String(child.response.headers.get('content-type') || '').toLowerCase();
      if (childType.includes('mpegurl') || /\.m3u8(?:$|[?#])/i.test(child.finalUrl)) {
        const childManifest = await readTextLimited(child.response);
        if (!childManifest.trimStart().startsWith('#EXTM3U')) {
          return { valid: false, reason: 'La variante HLS es inválida.' };
        }
        const childUris = hlsUris(childManifest, child.finalUrl);
        if (!childUris.length) {
          return { valid: false, reason: 'La variante HLS no contiene segmentos.' };
        }
        childUrl = childUris.find((item) => !/\.m3u8(?:$|[?#])/i.test(item)) || childUris[0];
        child = await fetchPublic(
          childUrl,
          upstreamHeaders(headersData, { Range: 'bytes=0-2047', Referer: headersData.referer || first.finalUrl }),
          { timeoutMs },
        );
        if (!child.response.ok || (await readFirstChunk(child.response)) === 0) {
          return { valid: false, reason: `El primer segmento no respondió correctamente (HTTP ${child.response.status}).` };
        }
      } else if ((await readFirstChunk(child.response)) === 0) {
        return { valid: false, reason: 'El primer segmento está vacío.' };
      }

      return {
        valid: true,
        type: 'hls',
        finalUrl: first.finalUrl,
        manifestUriCount: firstUris.length,
        sampleUrl: childUrl,
        status: first.response.status,
      };
    }

    if (type === 'dash') {
      const body = await readTextLimited(first.response);
      return {
        valid: /<MPD\b/i.test(body),
        type: 'dash',
        finalUrl: first.finalUrl,
        reason: /<MPD\b/i.test(body) ? '' : 'La respuesta no contiene un manifiesto MPD.',
      };
    }

    const size = await readFirstChunk(first.response);
    return {
      valid: size > 0,
      type: 'mp4',
      finalUrl: first.finalUrl,
      reason: size > 0 ? '' : 'La respuesta de video está vacía.',
    };
  } catch (error) {
    return { valid: false, reason: error.message || 'No se pudo validar la fuente.' };
  }
}

function rewriteHls(text, baseUrl, req, headers, expiresAt) {
  const rewrite = (value) => {
    try {
      const absolute = new URL(value, baseUrl).toString();
      if (!/^https?:\/\//i.test(absolute)) return value;
      return proxyUrl(req, absolute, headers, expiresAt);
    } catch {
      return value;
    }
  };

  return String(text || '').split(/\r?\n/).map((rawLine) => {
    const line = rawLine.trim();
    if (!line) return rawLine;
    if (!line.startsWith('#')) return rewrite(line);
    return rawLine.replace(/URI=(?:"([^"]+)"|'([^']+)'|([^,\s]+))/gi, (match, a, b, c) => {
      const original = a || b || c;
      return `URI="${rewrite(original)}"`;
    });
  }).join('\n');
}

export async function proxyMedia(req, res) {
  const payload = unseal(req.params.token);
  const headersData = sanitizedHeaders(payload.headers);
  const extra = {};
  if (req.headers.range) extra.Range = req.headers.range;
  const { response, finalUrl } = await fetchPublic(
    payload.url,
    upstreamHeaders(headersData, extra),
    { method: req.method, timeoutMs: 15000 },
  );

  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Expose-Headers', 'Content-Length,Content-Range,Accept-Ranges');

  if (req.method === 'HEAD') {
    res.status(response.status);
    for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const value = response.headers.get(name);
      if (value) res.set(name, value);
    }
    return res.end();
  }

  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  const looksHls = contentType.includes('mpegurl') || /\.m3u8(?:$|[?#])/i.test(finalUrl);

  if (looksHls) {
    const manifest = await readTextLimited(response);
    if (!manifest.trimStart().startsWith('#EXTM3U')) {
      throw new HttpError(502, 'La fuente dejó de devolver un manifiesto HLS válido.');
    }
    const rewritten = rewriteHls(manifest, finalUrl, req, headersData, payload.expiresAt);
    res.status(response.status);
    res.set('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
    res.set('Cache-Control', 'no-store, max-age=0');
    return res.send(rewritten);
  }

  res.status(response.status);
  for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control']) {
    const value = response.headers.get(name);
    if (value) res.set(name, value);
  }

  if (!response.body) return res.end();
  return Readable.fromWeb(response.body).pipe(res);
}
