import dns from 'node:dns/promises';
import net from 'node:net';

import { HttpError } from '../utils/httpError.js';

const MAX_REDIRECTS = 3;
const MAX_BYTES = 96 * 1024;
const REQUEST_TIMEOUT_MS = 3500;

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
    throw new HttpError(400, 'La prueba solo acepta URLs HTTP o HTTPS.');
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
    throw new HttpError(400, 'No fue posible resolver el dominio del stream.');
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

async function fetchLimited(initialUrl) {
  let currentUrl = new URL(initialUrl);

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    await assertPublicTarget(currentUrl);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(currentUrl, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          Accept:
            'application/vnd.apple.mpegurl, application/x-mpegURL, application/dash+xml, video/*, */*;q=0.5',
          Range: `bytes=0-${MAX_BYTES - 1}`,
          'User-Agent': 'Mozilla/5.0 (Smart-TV-Streaming-Admin/1.1)',
        },
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

  throw new HttpError(502, 'No fue posible completar la prueba.');
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
    return new URL(value, baseUrl).toString();
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
    message: error.message || 'No fue posible comprobar la fuente.',
  };
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
        message:
          'RTMP no se reproduce directamente en el navegador. Usa una salida HLS o DASH.',
      },
    });
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    throw new HttpError(400, 'La URL no tiene un formato válido.');
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

  const looksPlayable =
    response.ok &&
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
      message,
    },
  });
}
