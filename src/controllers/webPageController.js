import dns from 'node:dns/promises';
import net from 'node:net';

import { HttpError } from '../utils/httpError.js';

const MAX_REDIRECTS = 4;
const MAX_HTML_BYTES = 3 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 12000;

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
    throw new HttpError(400, 'Solo se pueden mostrar páginas HTTP o HTTPS.');
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
    throw new HttpError(400, 'No fue posible resolver el dominio de la página.');
  }

  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new HttpError(400, 'El dominio apunta a una dirección privada o no válida.');
  }
}

async function readBodyLimited(response) {
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;

  try {
    while (total < MAX_HTML_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;

      const remaining = MAX_HTML_BYTES - total;
      const chunk = Buffer.from(value.subarray(0, remaining));
      chunks.push(chunk);
      total += chunk.length;

      if (value.length > remaining) {
        throw new HttpError(413, 'La página HTML es demasiado grande para mostrarse.');
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // La lectura ya terminó.
    }
  }

  return Buffer.concat(chunks, total);
}

async function fetchHtml(initialUrl) {
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
          Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
          'Accept-Language': 'es-MX,es;q=0.9,en;q=0.7',
          'User-Agent':
            'Mozilla/5.0 (SMART-TV; LINUX; Tizen 5.5) AppleWebKit/538.1 (KHTML, like Gecko) SamsungBrowser/2.1 TV Safari/538.1',
        },
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        clearTimeout(timeout);
        controller.abort();

        if (!location) {
          throw new HttpError(502, 'La página respondió con una redirección sin destino.');
        }

        if (redirectCount === MAX_REDIRECTS) {
          throw new HttpError(502, 'La página excedió el límite de redirecciones.');
        }

        currentUrl = new URL(location, currentUrl);
        continue;
      }

      const body = await readBodyLimited(response);
      clearTimeout(timeout);
      controller.abort();

      if (!response.ok) {
        throw new HttpError(502, `La página respondió HTTP ${response.status}.`);
      }

      const contentType = response.headers.get('content-type') || '';
      const html = body.toString('utf8').replace(/^\uFEFF/, '');

      if (
        !contentType.toLowerCase().includes('html') &&
        !/^\s*(?:<!doctype\s+html|<html|<head|<body)/i.test(html)
      ) {
        throw new HttpError(415, 'La URL no devolvió una página HTML.');
      }

      return {
        html,
        finalUrl: currentUrl.toString(),
      };
    } catch (error) {
      clearTimeout(timeout);
      controller.abort();

      if (error?.name === 'AbortError') {
        throw new HttpError(408, 'La página tardó demasiado en responder.');
      }

      if (error instanceof HttpError) throw error;

      throw new HttpError(502, `No fue posible cargar la página: ${error.message}`);
    }
  }

  throw new HttpError(502, 'No fue posible completar la carga de la página.');
}

function escapeHtmlAttribute(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function getPublicOrigin(req) {
  const forwardedProtocol = String(req.get('x-forwarded-proto') || '')
    .split(',')[0]
    .trim();
  const protocol = forwardedProtocol || req.protocol || 'https';
  const host = req.get('x-forwarded-host') || req.get('host');
  return `${protocol}://${host}`;
}

function buildBridgeScript({ proxyEndpoint, mode }) {
  const proxyJson = JSON.stringify(proxyEndpoint);
  const modeJson = JSON.stringify(mode);

  return `
<script data-tvstream-bridge>
(function () {
  'use strict';

  var PROXY_ENDPOINT = ${proxyJson};
  var MODE = ${modeJson};

  function absoluteUrl(value) {
    try {
      return new URL(value, document.baseURI).toString();
    } catch (_) {
      return '';
    }
  }

  function canProxy(url) {
    return /^https?:\\/\\//i.test(url);
  }

  function proxyUrl(url) {
    return PROXY_ENDPOINT +
      '?mode=' + encodeURIComponent(MODE) +
      '&url=' + encodeURIComponent(url);
  }

  function sendToHost(type, payload) {
    if (MODE !== 'tv') return false;

    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({
          source: 'tvstream-frame',
          type: type,
          payload: payload || {}
        }, '*');
        return true;
      }
    } catch (_) {}

    return false;
  }

  function navigateInside(url) {
    var destination = absoluteUrl(url);
    if (!canProxy(destination)) return false;

    if (sendToHost('navigate', { url: destination, title: document.title || '' })) {
      return false;
    }

    window.location.replace(proxyUrl(destination));
    return false;
  }

  function blockedWindowOpen(url) {
    if (url) navigateInside(url);
    return null;
  }

  try {
    Object.defineProperty(window, 'open', {
      configurable: false,
      enumerable: true,
      writable: false,
      value: blockedWindowOpen
    });
  } catch (_) {
    window.open = blockedWindowOpen;
  }

  window.__TVSTREAM_NAVIGATE__ = navigateInside;

  function normalizeTargets(root) {
    var scope = root && root.querySelectorAll ? root : document;

    var links = scope.querySelectorAll('a[target], area[target]');
    for (var index = 0; index < links.length; index += 1) {
      links[index].setAttribute('target', '_self');
      links[index].removeAttribute('rel');
    }

    var forms = scope.querySelectorAll('form[target]');
    for (var formIndex = 0; formIndex < forms.length; formIndex += 1) {
      forms[formIndex].setAttribute('target', '_self');
    }

    var bases = scope.querySelectorAll('base[target]');
    for (var baseIndex = 0; baseIndex < bases.length; baseIndex += 1) {
      bases[baseIndex].removeAttribute('target');
    }
  }

  document.addEventListener('click', function (event) {
    var element = event.target;

    while (
      element &&
      element !== document &&
      !/^(a|area)$/i.test(String(element.tagName || ''))
    ) {
      element = element.parentNode;
    }

    if (!element) return;

    var rawHref = element.getAttribute('href') || element.href || '';
    var href = absoluteUrl(rawHref);
    if (!canProxy(href)) return;

    event.preventDefault();
    event.stopPropagation();
    if (event.stopImmediatePropagation) event.stopImmediatePropagation();
    navigateInside(href);
  }, true);

  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!form) return;

    var method = String(form.method || 'get').toLowerCase();
    if (method !== 'get') {
      event.preventDefault();
      event.stopPropagation();
      if (event.stopImmediatePropagation) event.stopImmediatePropagation();
      return;
    }

    var action = absoluteUrl(form.action || document.baseURI);
    if (!canProxy(action)) return;

    try {
      var query = new URLSearchParams(new FormData(form));
      var destination = new URL(action);
      query.forEach(function (value, key) {
        destination.searchParams.append(key, value);
      });

      event.preventDefault();
      event.stopPropagation();
      if (event.stopImmediatePropagation) event.stopImmediatePropagation();
      navigateInside(destination.toString());
    } catch (_) {}
  }, true);

  document.addEventListener('DOMContentLoaded', function () {
    normalizeTargets(document);

    if (window.MutationObserver) {
      var observer = new MutationObserver(function (mutations) {
        for (var index = 0; index < mutations.length; index += 1) {
          var added = mutations[index].addedNodes || [];
          for (var nodeIndex = 0; nodeIndex < added.length; nodeIndex += 1) {
            var node = added[nodeIndex];
            if (node && node.nodeType === 1) normalizeTargets(node);
          }
        }
      });

      observer.observe(document.documentElement, {
        childList: true,
        subtree: true
      });
    }

    sendToHost('ready', {
      title: document.title || '',
      url: document.baseURI || ''
    });
  });

  window.addEventListener('keydown', function (event) {
    var code = event.keyCode || event.which;

    if (MODE === 'tv' && (code === 10009 || code === 27 || event.key === 'Escape')) {
      event.preventDefault();
      event.stopPropagation();
      if (event.stopImmediatePropagation) event.stopImmediatePropagation();
      sendToHost('close', {});
    }
  }, true);
})();
</script>`;
}

function injectIntoHtml(html, finalUrl, bridgeScript) {
  let output = html
    .replace(/<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi, '')
    .replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi, '')
    .replace(/<base\b[^>]*>/gi, '')
    .replace(/\s+target\s*=\s*["'](?:_blank|_top|_parent)["']/gi, ' target="_self"');

  const injection = `<base href="${escapeHtmlAttribute(finalUrl)}">${bridgeScript}`;

  if (/<head\b[^>]*>/i.test(output)) {
    return output.replace(/<head\b[^>]*>/i, (match) => `${match}${injection}`);
  }

  if (/<html\b[^>]*>/i.test(output)) {
    return output.replace(/<html\b[^>]*>/i, (match) => `${match}<head>${injection}</head>`);
  }

  return `<!doctype html><html><head>${injection}</head><body>${output}</body></html>`;
}

export async function renderWebPage(req, res) {
  const rawUrl = String(req.query?.url || '').trim();
  const mode = String(req.query?.mode || 'admin').toLowerCase() === 'tv' ? 'tv' : 'admin';

  if (!rawUrl) {
    throw new HttpError(400, 'La URL de la página es obligatoria.');
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    throw new HttpError(400, 'La URL no tiene un formato válido.');
  }

  const { html, finalUrl } = await fetchHtml(parsedUrl);
  const proxyEndpoint = new URL('/api/v1/web-pages/render', getPublicOrigin(req)).toString();
  const bridgeScript = buildBridgeScript({ proxyEndpoint, mode });
  const renderedHtml = injectIntoHtml(html, finalUrl, bridgeScript);

  // Esta ruta debe poder mostrarse dentro del panel administrativo.
  res.removeHeader('X-Frame-Options');
  res.removeHeader('Cross-Origin-Opener-Policy');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Content-Disposition', 'inline');
  res.setHeader('Referrer-Policy', 'no-referrer-when-downgrade');
  res.setHeader(
    'Content-Security-Policy',
    "default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; connect-src * data: blob:; img-src * data: blob:; media-src * data: blob:; frame-src * data: blob:; child-src * data: blob:; style-src * 'unsafe-inline'; script-src * 'unsafe-inline' 'unsafe-eval'; frame-ancestors *;",
  );
  res.type('html').send(renderedHtml);
}
