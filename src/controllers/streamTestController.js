import dns from 'node:dns/promises';
import net from 'node:net';

import { resolveStreamWithBrowser } from '../services/browserStreamResolver.js';
import { validateMediaCandidate } from '../services/mediaGateway.js';
import { HttpError } from '../utils/httpError.js';

const MAX_REDIRECTS = 4;
const MAX_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 4000;
const RESOLVE_MAX_DEPTH = 1;
const RESOLVE_MAX_REQUESTS = 3;

function isPrivateIpv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) return true;

  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function isPrivateIpv6(address) {
  const normalized = address.toLowerCase();
  return (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb') ||
    normalized.startsWith('::ffff:127.') ||
    normalized.startsWith('::ffff:10.') ||
    normalized.startsWith('::ffff:192.168.')
  );
}

function isPrivateAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return isPrivateIpv4(address);
  if (family === 6) return isPrivateIpv6(address);
  return true;
}

async function assertPublicTarget(url) {
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new HttpError(400, 'Solo se aceptan URLs HTTP o HTTPS.');
  }

  const hostname = url.hostname.toLowerCase();

  if (hostname === 'localhost' || hostname.endsWith('.local')) {
    throw new HttpError(400, 'No se permiten direcciones locales.');
  }

  if (net.isIP(hostname)) {
    if (isPrivateAddress(hostname)) {
      throw new HttpError(400, 'No se permiten direcciones privadas o locales.');
    }
    return;
  }

  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new HttpError(400, 'No fue posible resolver el dominio.');
  }

  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new HttpError(400, 'El dominio apunta a una dirección privada o no válida.');
  }
}

async function readLimitedBody(response, controller) {
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;

  try {
    while (total < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;

      const remaining = MAX_BYTES - total;
      const chunk = Buffer.from(value.subarray(0, remaining));
      chunks.push(chunk);
      total += chunk.length;

      if (value.length >= remaining) break;
    }
  } finally {
    controller.abort();
    try {
      await reader.cancel();
    } catch {
      // La respuesta ya terminó.
    }
  }

  return Buffer.concat(chunks, total);
}

async function fetchLimited(initialUrl, options = {}) {
  let currentUrl = new URL(initialUrl);
  let currentReferer = options.referer || '';

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    await assertPublicTarget(currentUrl);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const headers = {
        Accept:
          options.accept ||
          'text/html,application/xhtml+xml,application/vnd.apple.mpegurl,application/x-mpegURL,application/dash+xml,video/*,*/*;q=0.5',
        Range: `bytes=0-${MAX_BYTES - 1}`,
        'User-Agent':
          'Mozilla/5.0 (SMART-TV; LINUX; Tizen 5.5) AppleWebKit/538.1 SamsungBrowser/2.1 TV Safari/538.1',
      };

      if (currentReferer) headers.Referer = currentReferer;

      const response = await fetch(currentUrl, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers,
      });

      if (response.status >= 300 && response.status < 400) {
        clearTimeout(timeout);
        controller.abort();

        const location = response.headers.get('location');
        if (!location) {
          throw new HttpError(502, 'La fuente respondió con una redirección sin destino.');
        }

        if (redirectCount === MAX_REDIRECTS) {
          throw new HttpError(502, 'La fuente excedió el límite de redirecciones.');
        }

        currentReferer = currentUrl.toString();
        currentUrl = new URL(location, currentUrl);
        continue;
      }

      const body = await readLimitedBody(response, controller);
      clearTimeout(timeout);

      return {
        response,
        body,
        finalUrl: currentUrl.toString(),
      };
    } catch (error) {
      clearTimeout(timeout);
      controller.abort();

      if (error?.name === 'AbortError') {
        throw new HttpError(408, 'La fuente tardó demasiado en responder.');
      }

      if (error instanceof HttpError) throw error;

      throw new HttpError(
        502,
        `No fue posible conectar con la fuente: ${error.message}`,
      );
    }
  }

  throw new HttpError(502, 'No fue posible completar la solicitud.');
}

function detectType(url, contentType, text) {
  const normalizedUrl = url.toLowerCase();
  const normalizedType = contentType.toLowerCase();
  const trimmed = text.trimStart();

  if (trimmed.startsWith('#EXTM3U')) return 'hls';
  if (normalizedType.includes('mpegurl') || normalizedUrl.includes('.m3u8')) return 'hls';
  if (normalizedType.includes('dash+xml') || normalizedUrl.includes('.mpd')) return 'dash';
  if (normalizedType.startsWith('video/') || normalizedUrl.includes('.mp4')) return 'mp4';
  if (normalizedType.includes('html') || /^<!doctype html|^<html/i.test(trimmed)) return 'html';

  return 'other';
}

function resolveReferencedUrl(baseUrl, value) {
  try {
    const cleaned = String(value || '')
      .trim()
      .replace(/&amp;/gi, '&')
      .replace(/\\u002f/gi, '/')
      .replace(/\\\//g, '/');

    if (!cleaned || cleaned.startsWith('javascript:') || cleaned.startsWith('data:')) {
      return null;
    }

    return new URL(cleaned, baseUrl).toString();
  } catch {
    return null;
  }
}

function inspectHls(text, baseUrl) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const variants = [];
  const segments = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const nextUri = lines.slice(index + 1).find((candidate) => !candidate.startsWith('#'));
      if (nextUri) variants.push(resolveReferencedUrl(baseUrl, nextUri));
      continue;
    }

    if (!line.startsWith('#')) {
      segments.push(resolveReferencedUrl(baseUrl, line));
    }
  }

  return {
    valid: lines[0] === '#EXTM3U',
    isMaster: variants.length > 0,
    variantCount: variants.filter(Boolean).length,
    segmentCount: segments.filter(Boolean).length,
    sampleUrl: variants.find(Boolean) || segments.find(Boolean) || null,
  };
}

function decodePossibleBase64(value) {
  const compact = String(value || '').replace(/\s+/g, '');
  if (compact.length < 40 || compact.length > 8192 || !/^[A-Za-z0-9+/=_-]+$/.test(compact)) {
    return '';
  }

  try {
    const normalized = compact.replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(normalized, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

function isMediaUrl(url) {
  const normalized = String(url || '').toLowerCase();
  return (
    normalized.includes('.m3u8') ||
    normalized.includes('.mpd') ||
    normalized.includes('.mp4') ||
    normalized.includes('format=m3u8') ||
    normalized.includes('type=m3u8')
  );
}

function extractCandidates(html, baseUrl) {
  const normalizedHtml = String(html || '')
    .replace(/\\u002f/gi, '/')
    .replace(/\\\//g, '/')
    .replace(/&amp;/gi, '&');

  const rawValues = [];
  const addMatches = (regex, group = 1) => {
    let match;
    while ((match = regex.exec(normalizedHtml)) !== null) {
      if (match[group]) rawValues.push(match[group]);
      if (rawValues.length > 300) break;
    }
  };

  addMatches(/(?:src|href|file|source|playlist|hls|url|data-src|data-url)\s*[:=]\s*["']([^"']+)["']/gi);
  addMatches(/["'](?:src|file|source|playlist|hls|url)["']\s*:\s*["']([^"']+)["']/gi);
  addMatches(/(https?:\/\/[^\s"'<>\\]+)/gi);
  addMatches(/(\/\/[^\s"'<>\\]+)/gi);
  addMatches(/([A-Za-z0-9_./?=&%-]+\.(?:m3u8|mpd|mp4)(?:\?[^\s"'<>\\]*)?)/gi);

  const encodedMatches = normalizedHtml.match(/[A-Za-z0-9+/=_-]{40,}/g) || [];
  for (const encoded of encodedMatches.slice(0, 30)) {
    const decoded = decodePossibleBase64(encoded);
    if (!decoded) continue;

    const urls = decoded.match(/https?:\/\/[^\s"'<>]+/gi) || [];
    rawValues.push(...urls);
  }

  const media = [];
  const pages = [];
  const seen = new Set();

  for (const rawValue of rawValues) {
    const resolved = resolveReferencedUrl(baseUrl, rawValue);
    if (!resolved || seen.has(resolved)) continue;
    seen.add(resolved);

    if (isMediaUrl(resolved)) {
      media.push(resolved);
      continue;
    }

    if (/^https?:\/\//i.test(resolved)) pages.push(resolved);
  }

  return {
    media: media.slice(0, 40),
    pages: pages.slice(0, 40),
  };
}

export async function resolveWebMedia(rawUrl, options = {}) {
  let originalStartUrl;
  try {
    originalStartUrl = new URL(rawUrl);
  } catch {
    throw new HttpError(400, 'La URL no tiene un formato válido.');
  }

  const preferredType = String(options.preferredType || '').toLowerCase();
  const initialPages = [];

  // Algunas páginas permiten solicitar explícitamente HLS o DASH mediante
  // manifest_type. Para Roku preferimos HLS, pero nunca destruimos la URL
  // original: si la variante HLS no existe, se intenta la página original.
  if (preferredType === 'hls' && originalStartUrl.searchParams.has('manifest_type')) {
    const preferred = new URL(originalStartUrl);
    preferred.searchParams.set('manifest_type', 'hls');
    initialPages.push(preferred.toString());
  }
  initialPages.push(originalStartUrl.toString());

  const queue = [...new Set(initialPages)].map((url) => ({ url, depth: 0, referer: '' }));
  const visited = new Set();
  let requests = 0;
  let lastReachablePage = null;
  const staticValid = [];

  while (queue.length && requests < Math.max(RESOLVE_MAX_REQUESTS, initialPages.length + 2)) {
    const current = queue.shift();
    if (!current || visited.has(current.url)) continue;
    visited.add(current.url);
    requests += 1;

    let fetched;
    try {
      fetched = await fetchLimited(current.url, { referer: current.referer });
    } catch {
      continue;
    }

    const contentType = fetched.response.headers.get('content-type') || '';
    const text = fetched.body.toString('utf8');
    const detectedType = detectType(fetched.finalUrl, contentType, text);

    if (fetched.response.ok && ['hls', 'dash', 'mp4'].includes(detectedType)) {
      // IMPORTANTE: antes esta rama devolvía la primera URL encontrada sin
      // pasar por validateMediaCandidate(). Eso hacía que un MPD/playlist que
      // respondía HTTP 200 pero era incompatible llegara directo al Roku.
      const validation = await validateMediaCandidate({
        url: fetched.finalUrl,
        type: detectedType,
        referer: current.referer || originalStartUrl.toString(),
        userAgent: '',
        origin: '',
        cookie: '',
      }, { timeoutMs: 6000 });

      if (validation.valid) {
        const result = {
          resolved: true,
          playbackUrl: validation.finalUrl || fetched.finalUrl,
          resolvedType: detectedType,
          sourcePageUrl: originalStartUrl.toString(),
          resolvedFrom: current.referer || originalStartUrl.toString(),
          requests,
          resolverEngine: 'static-validated',
          cookieHeader: '',
          userAgent: '',
          referer: current.referer || originalStartUrl.toString(),
          warning: '',
          browserDiagnostics: null,
          validation,
          requiresProxy: detectedType === 'hls',
          message: `Flujo ${detectedType.toUpperCase()} encontrado y validado.`,
        };

        // Si Roku pidió HLS y ya lo encontramos, no tiene sentido seguir.
        if (preferredType === 'hls' && detectedType === 'hls') return result;
        staticValid.push(result);
      }
      // Si la URL multimedia no superó la validación, seguimos buscando.
      continue;
    }

    if (!fetched.response.ok || detectedType !== 'html') continue;

    lastReachablePage = fetched.finalUrl;
    if (current.depth >= RESOLVE_MAX_DEPTH) continue;

    const candidates = extractCandidates(text, fetched.finalUrl);
    const nextDepth = current.depth + 1;

    // HLS primero si Roku lo pidió. El resto conserva su orden normal.
    const mediaCandidates = candidates.media.slice().sort((a, b) => {
      if (preferredType !== 'hls') return 0;
      const ah = /\.m3u8(?:$|[?#])/i.test(a) ? 1 : 0;
      const bh = /\.m3u8(?:$|[?#])/i.test(b) ? 1 : 0;
      return bh - ah;
    });

    for (let index = mediaCandidates.length - 1; index >= 0; index -= 1) {
      queue.unshift({
        url: mediaCandidates[index],
        depth: nextDepth,
        referer: fetched.finalUrl,
      });
    }

    for (const pageUrl of candidates.pages) {
      if (!visited.has(pageUrl)) {
        queue.push({
          url: pageUrl,
          depth: nextDepth,
          referer: fetched.finalUrl,
        });
      }
    }
  }

  if (staticValid.length) {
    staticValid.sort((a, b) => {
      if (preferredType === 'hls') {
        if (a.resolvedType === 'hls' && b.resolvedType !== 'hls') return -1;
        if (b.resolvedType === 'hls' && a.resolvedType !== 'hls') return 1;
      }
      return 0;
    });
    return staticValid[0];
  }

  // Si la página original pide MPD, damos primero al navegador la variante HLS
  // para Roku. Si no resuelve nada, se reintenta con la URL original.
  const browserUrls = [];
  if (preferredType === 'hls' && originalStartUrl.searchParams.has('manifest_type')) {
    const preferred = new URL(originalStartUrl);
    preferred.searchParams.set('manifest_type', 'hls');
    browserUrls.push(preferred.toString());
  }
  browserUrls.push(originalStartUrl.toString());

  let lastBrowserResolution = null;
  for (const browserUrl of [...new Set(browserUrls)]) {
    const browserResolution = await resolveStreamWithBrowser(browserUrl, {
      ...options,
      preferredType,
    });
    lastBrowserResolution = browserResolution;

    if (browserResolution.resolved) {
      if (preferredType !== 'hls' || browserResolution.resolvedType === 'hls') {
        return {
          ...browserResolution,
          sourcePageUrl: originalStartUrl.toString(),
          resolvedFrom: browserResolution.referer || lastReachablePage || originalStartUrl.toString(),
          requests,
          staticRequests: requests,
          browserAttempted: true,
        };
      }
      staticValid.push({
        ...browserResolution,
        sourcePageUrl: originalStartUrl.toString(),
        resolvedFrom: browserResolution.referer || lastReachablePage || originalStartUrl.toString(),
        requests,
        staticRequests: requests,
        browserAttempted: true,
      });
    }
  }

  if (staticValid.length) return staticValid[0];

  const browserResolution = lastBrowserResolution || {
    resolved: false,
    playbackUrl: null,
    resolvedType: null,
    message: 'No se encontró una fuente multimedia compatible.',
  };

  return {
    ...browserResolution,
    sourcePageUrl: originalStartUrl.toString(),
    resolvedFrom: lastReachablePage,
    requests,
    staticRequests: requests,
    browserAttempted: true,
    message:
      browserResolution.message ||
      'La página respondió, pero no se encontró una URL directa HLS, DASH o MP4 compatible. La app no abrirá el navegador.',
  };
}

function diagnosticFailure(error, requestedType) {
  return {
    reachable: false,
    looksPlayable: false,
    requestedType: requestedType || null,
    detectedType: null,
    status: error.statusCode || null,
    finalUrl: null,
    contentType: null,
    contentLength: null,
    bytesInspected: 0,
    hls: null,
    child: null,
    resolvedPlaybackUrl: null,
    resolvedType: null,
    resolverEngine: null,
    cookieHeader: '',
    userAgent: '',
    referer: '',
    warning: '',
    browserDiagnostics: null,
    message: error.message || 'No fue posible comprobar la fuente.',
  };
}

export async function resolveStream(req, res) {
  const rawUrl = String(req.body?.url || '').trim();
  if (!rawUrl) throw new HttpError(400, 'La URL es obligatoria.');

  const resolution = await resolveWebMedia(rawUrl, {
    forceRefresh: req.body?.forceRefresh === true,
  });
  return res.json({ ok: true, data: resolution });
}

export async function testStream(req, res) {
  const rawUrl = String(req.body?.url || '').trim();
  const requestedType = String(req.body?.streamType || '').trim().toLowerCase();

  if (!rawUrl) {
    throw new HttpError(400, 'La URL es obligatoria.');
  }

  if (/^rtmps?:\/\//i.test(rawUrl)) {
    return res.json({
      ok: true,
      data: {
        reachable: false,
        looksPlayable: false,
        requestedType: requestedType || 'rtmp',
        detectedType: 'rtmp',
        status: null,
        finalUrl: rawUrl,
        contentType: null,
        contentLength: null,
        bytesInspected: 0,
        hls: null,
        child: null,
        resolvedPlaybackUrl: null,
        resolvedType: null,
        message:
          'RTMP no se reproduce directamente. Usa una salida HLS o DASH.',
      },
    });
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    throw new HttpError(400, 'La URL no tiene un formato válido.');
  }

  if (requestedType === 'web') {
    const resolution = await resolveWebMedia(rawUrl, {
      forceRefresh: req.body?.forceRefresh === true,
    });

    return res.json({
      ok: true,
      data: {
        reachable: Boolean(resolution.resolvedFrom || resolution.resolved),
        looksPlayable: Boolean(resolution.resolved),
        requestedType: 'web',
        detectedType: 'html',
        status: resolution.resolved ? 200 : null,
        finalUrl: resolution.sourcePageUrl || rawUrl,
        contentType: 'text/html',
        contentLength: null,
        bytesInspected: 0,
        hls: null,
        child: null,
        resolvedPlaybackUrl: resolution.playbackUrl,
        resolvedType: resolution.resolvedType,
        resolverEngine: resolution.resolverEngine || 'static',
        cookieHeader: resolution.cookieHeader || '',
        userAgent: resolution.userAgent || '',
        referer: resolution.referer || '',
        warning: resolution.warning || '',
        browserDiagnostics: resolution.browserDiagnostics || null,
        resolverRequests: resolution.requests || 0,
        message: resolution.message,
      },
    });
  }

  let fetched;
  try {
    fetched = await fetchLimited(parsedUrl);
  } catch (error) {
    return res.json({
      ok: true,
      data: diagnosticFailure(error, requestedType),
    });
  }

  const { response, body, finalUrl } = fetched;
  const contentType = response.headers.get('content-type') || '';
  const contentLength = response.headers.get('content-length');
  const text = body.toString('utf8');
  const detectedType = detectType(finalUrl, contentType, text);
  const hls = detectedType === 'hls' ? inspectHls(text, finalUrl) : null;
  const looksPlayable = response.ok &&
    detectedType !== 'html' &&
    detectedType !== 'other' &&
    (!hls || hls.valid);

  let message = 'La fuente respondió correctamente.';

  if (!response.ok) {
    message = `La fuente respondió HTTP ${response.status}.`;
  } else if (detectedType === 'html') {
    message = 'La URL devolvió una página HTML, no un stream directo.';
  } else if (detectedType === 'other') {
    message = 'La respuesta no parece ser HLS, DASH o video MP4.';
  } else if (hls && !hls.valid) {
    message = 'La respuesta parece HLS, pero el manifiesto no inicia con #EXTM3U.';
  }

  return res.json({
    ok: true,
    data: {
      reachable: response.ok,
      looksPlayable,
      requestedType: requestedType || null,
      detectedType,
      status: response.status,
      finalUrl,
      contentType,
      contentLength: contentLength ? Number(contentLength) : null,
      bytesInspected: body.length,
      hls,
      child: null,
      resolvedPlaybackUrl: null,
      resolvedType: null,
      resolverEngine: 'direct',
      cookieHeader: '',
      userAgent: '',
      referer: '',
      warning: '',
      browserDiagnostics: null,
      resolverRequests: 0,
      message,
    },
  });
}
