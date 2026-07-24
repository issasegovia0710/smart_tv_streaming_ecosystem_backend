import dns from 'node:dns/promises';
import { existsSync } from 'node:fs';
import net from 'node:net';

const DEFAULT_TIMEOUT_MS = 24000;
const NETWORK_SETTLE_MS = 6500;
const CACHE_TTL_MS = 2 * 60 * 1000;
const MAX_BODY_INSPECTIONS = 24;
const MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';
const DEFAULT_CHROMIUM_PACK_URL =
  'https://github.com/Sparticuz/chromium/releases/download/v143.0.4/chromium-v143.0.4-pack.tar';

const resolutionCache = new Map();

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

async function assertPublicUrl(rawUrl, dnsCache) {
  const url = rawUrl instanceof URL ? rawUrl : new URL(rawUrl);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Solo se permiten solicitudes HTTP o HTTPS.');
  }

  const hostname = url.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.local')) {
    throw new Error('No se permiten direcciones locales.');
  }

  if (net.isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw new Error('No se permiten direcciones privadas.');
    return;
  }

  if (dnsCache.has(hostname)) {
    if (!dnsCache.get(hostname)) throw new Error('El dominio no es público.');
    return;
  }

  const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  const allowed = Boolean(addresses.length) && addresses.every(({ address }) => !isPrivateAddress(address));
  dnsCache.set(hostname, allowed);
  if (!allowed) throw new Error('El dominio apunta a una dirección privada o no válida.');
}

function normalizeMediaUrl(value, baseUrl) {
  try {
    const cleaned = String(value || '')
      .trim()
      .replace(/&amp;/gi, '&')
      .replace(/\\u002f/gi, '/')
      .replace(/\\\//g, '/');

    if (!cleaned || cleaned.startsWith('blob:') || cleaned.startsWith('data:')) return null;
    const resolved = new URL(cleaned, baseUrl).toString();
    return /^https?:\/\//i.test(resolved) ? resolved : null;
  } catch {
    return null;
  }
}

function mediaTypeFrom(url, contentType = '') {
  const normalizedUrl = String(url || '').toLowerCase();
  const normalizedType = String(contentType || '').toLowerCase();

  if (
    normalizedType.includes('mpegurl') ||
    /\.m3u8(?:$|[?#])/i.test(normalizedUrl) ||
    normalizedUrl.includes('format=m3u8') ||
    normalizedUrl.includes('type=m3u8')
  ) return 'hls';

  if (normalizedType.includes('dash+xml') || /\.mpd(?:$|[?#])/i.test(normalizedUrl)) {
    return 'dash';
  }

  if (
    normalizedType.startsWith('video/') ||
    /\.(?:mp4|m4v|webm)(?:$|[?#])/i.test(normalizedUrl)
  ) return 'mp4';

  return null;
}

function scoreCandidate(candidate) {
  const url = candidate.url.toLowerCase();
  let score = candidate.type === 'hls' ? 100 : candidate.type === 'dash' ? 95 : 80;

  if (candidate.status >= 200 && candidate.status < 400) score += 18;
  if (candidate.contentType) score += 12;
  if (/master|index|playlist|manifest|live|stream|channel|watch/.test(url)) score += 15;
  if (/chunk|segment|frag|\.ts(?:$|[?#])|\.m4s(?:$|[?#])/.test(url)) score -= 30;
  if (/ad[sx]?|doubleclick|googlesyndication|vast|ima|promo|tracker|analytics/.test(url)) score -= 90;
  if (candidate.resourceType === 'media') score += 20;
  if (candidate.resourceType === 'xhr' || candidate.resourceType === 'fetch') score += 8;

  return score;
}

function extractMediaUrls(text, baseUrl) {
  const normalized = String(text || '')
    .replace(/\\u002f/gi, '/')
    .replace(/\\\//g, '/')
    .replace(/&amp;/gi, '&');
  const values = new Set();
  const expressions = [
    /https?:\/\/[^\s"'<>\\]+/gi,
    /\/\/[^\s"'<>\\]+/gi,
    /[A-Za-z0-9_./?=&%+~-]+\.(?:m3u8|mpd|mp4)(?:\?[^\s"'<>\\]*)?/gi,
  ];

  for (const expression of expressions) {
    let match;
    while ((match = expression.exec(normalized)) !== null) {
      const resolved = normalizeMediaUrl(match[0], baseUrl);
      if (resolved && mediaTypeFrom(resolved)) values.add(resolved);
      if (values.size >= 80) break;
    }
  }

  return [...values];
}

function localChromeCandidates() {
  return [
    process.env.CHROME_EXECUTABLE_PATH,
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA
      ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`
      : '',
  ].filter(Boolean);
}

async function launchBrowser() {
  const { chromium: playwrightChromium } = await import('playwright-core');
  const wsEndpoint = String(process.env.BROWSER_WS_ENDPOINT || '').trim();

  if (wsEndpoint) {
    const browser = await playwrightChromium.connectOverCDP(wsEndpoint, {
      timeout: 15000,
    });
    return { browser, engine: 'browser-cdp' };
  }

  let executablePath = localChromeCandidates().find((candidate) => existsSync(candidate));
  let args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--no-zygote',
    '--autoplay-policy=no-user-gesture-required',
  ];

  if (!executablePath) {
    const chromiumModule = await import('@sparticuz/chromium-min');
    const serverlessChromium = chromiumModule.default;
    const packUrl = String(process.env.CHROMIUM_PACK_URL || DEFAULT_CHROMIUM_PACK_URL).trim();
    executablePath = await serverlessChromium.executablePath(packUrl);
    args = [...serverlessChromium.args, '--autoplay-policy=no-user-gesture-required'];
  }

  const browser = await playwrightChromium.launch({
    args,
    executablePath,
    headless: true,
    timeout: 15000,
  });

  return {
    browser,
    engine: executablePath.includes('/tmp/') ? 'browser-serverless' : 'browser-local',
  };
}

function buildFailure(message, details = {}) {
  return {
    resolved: false,
    playbackUrl: null,
    resolvedType: null,
    cookieHeader: '',
    userAgent: DEFAULT_USER_AGENT,
    referer: '',
    resolverEngine: details.resolverEngine || 'browser',
    browserDiagnostics: details.browserDiagnostics || null,
    warning: details.warning || '',
    message,
  };
}

function cacheGet(url) {
  const entry = resolutionCache.get(url);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > CACHE_TTL_MS) {
    resolutionCache.delete(url);
    return null;
  }
  return { ...entry.value, cached: true };
}

function cacheSet(url, value) {
  if (resolutionCache.size > 80) {
    const firstKey = resolutionCache.keys().next().value;
    if (firstKey) resolutionCache.delete(firstKey);
  }
  resolutionCache.set(url, { value, createdAt: Date.now() });
}

export async function resolveStreamWithBrowser(rawUrl) {
  const cached = cacheGet(rawUrl);
  if (cached) return cached;

  const startedAt = Date.now();
  const timeoutMs = Math.max(
    12000,
    Math.min(45000, Number(process.env.STREAM_RESOLVER_TIMEOUT_MS || DEFAULT_TIMEOUT_MS)),
  );
  const dnsCache = new Map();
  await assertPublicUrl(rawUrl, dnsCache);

  let browser;
  let context;
  let resolverEngine = 'browser';
  const candidates = new Map();
  const pendingBodyReads = new Set();
  let bodyInspections = 0;
  let pagesOpened = 0;
  let requestsObserved = 0;

  const addCandidate = (candidate) => {
    const url = normalizeMediaUrl(candidate.url, rawUrl);
    const type = mediaTypeFrom(url, candidate.contentType);
    if (!url || !type) return;

    const normalizedCandidate = {
      url,
      type,
      contentType: candidate.contentType || '',
      status: Number(candidate.status || 0),
      referer: candidate.referer || '',
      cookie: candidate.cookie || '',
      userAgent: candidate.userAgent || DEFAULT_USER_AGENT,
      resourceType: candidate.resourceType || '',
    };
    normalizedCandidate.score = scoreCandidate(normalizedCandidate);

    const current = candidates.get(url);
    if (!current || normalizedCandidate.score > current.score) {
      candidates.set(url, normalizedCandidate);
    }
  };

  const inspectTextBody = async (response) => {
    if (bodyInspections >= MAX_BODY_INSPECTIONS) return;
    const headers = await response.allHeaders().catch(() => ({}));
    const contentType = String(headers['content-type'] || '').toLowerCase();
    const contentLength = Number(headers['content-length'] || 0);
    const request = response.request();
    const requestHeaders = await request.allHeaders().catch(() => request.headers());
    const resourceType = request.resourceType();

    if (
      !['xhr', 'fetch', 'script', 'document'].includes(resourceType) &&
      !contentType.includes('json') &&
      !contentType.includes('javascript') &&
      !contentType.includes('text')
    ) return;

    if (contentLength > MAX_BODY_BYTES) return;
    bodyInspections += 1;

    try {
      const body = await response.text();
      if (body.length > MAX_BODY_BYTES) return;

      const trimmedBody = body.trimStart();
      if (trimmedBody.startsWith('#EXTM3U')) {
        addCandidate({
          url: response.url(),
          status: response.status(),
          contentType: 'application/vnd.apple.mpegurl',
          referer: requestHeaders.referer || '',
          cookie: requestHeaders.cookie || '',
          userAgent: requestHeaders['user-agent'] || DEFAULT_USER_AGENT,
          resourceType,
        });
      } else if (/^<\?xml[\s\S]*?<MPD\b|^<MPD\b/i.test(trimmedBody)) {
        addCandidate({
          url: response.url(),
          status: response.status(),
          contentType: 'application/dash+xml',
          referer: requestHeaders.referer || '',
          cookie: requestHeaders.cookie || '',
          userAgent: requestHeaders['user-agent'] || DEFAULT_USER_AGENT,
          resourceType,
        });
      }

      for (const mediaUrl of extractMediaUrls(body, response.url())) {
        addCandidate({
          url: mediaUrl,
          status: response.status(),
          contentType: '',
          referer: requestHeaders.referer || '',
          cookie: requestHeaders.cookie || '',
          userAgent: requestHeaders['user-agent'] || DEFAULT_USER_AGENT,
          resourceType,
        });
      }
    } catch {
      // Algunas respuestas no exponen cuerpo o ya fueron cerradas.
    }
  };

  try {
    const launched = await launchBrowser();
    browser = launched.browser;
    resolverEngine = launched.engine;

    context = await browser.newContext({
      userAgent: DEFAULT_USER_AGENT,
      viewport: { width: 1920, height: 1080 },
      ignoreHTTPSErrors: true,
      javaScriptEnabled: true,
      bypassCSP: true,
      locale: 'es-MX',
      timezoneId: 'America/Mexico_City',
      extraHTTPHeaders: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'es-MX,es;q=0.9,en;q=0.7',
      },
    });

    await context.route('**/*', async (route) => {
      const request = route.request();
      const requestUrl = request.url();
      const resourceType = request.resourceType();

      try {
        if (/^(?:data|blob|about):/i.test(requestUrl)) {
          await route.continue();
          return;
        }

        await assertPublicUrl(requestUrl, dnsCache);

        if (resourceType === 'font') {
          await route.abort();
          return;
        }

        await route.continue();
      } catch {
        await route.abort();
      }
    });

    const observedPages = new Set();

    const observePage = (observedPage) => {
      if (!observedPage || observedPages.has(observedPage)) return;
      observedPages.add(observedPage);
      pagesOpened += 1;

      observedPage.on('request', (request) => {
        requestsObserved += 1;
        const promise = (async () => {
          const headers = await request.allHeaders().catch(() => request.headers());
          addCandidate({
            url: request.url(),
            contentType: '',
            status: 0,
            referer: headers.referer || '',
            cookie: headers.cookie || '',
            userAgent: headers['user-agent'] || DEFAULT_USER_AGENT,
            resourceType: request.resourceType(),
          });
        })();

        pendingBodyReads.add(promise);
        promise.finally(() => pendingBodyReads.delete(promise));
      });

      observedPage.on('response', (response) => {
        const promise = (async () => {
          const headers = await response.allHeaders().catch(() => ({}));
          const request = response.request();
          const requestHeaders = await request.allHeaders().catch(() => request.headers());

          addCandidate({
            url: response.url(),
            contentType: headers['content-type'] || '',
            status: response.status(),
            referer: requestHeaders.referer || '',
            cookie: requestHeaders.cookie || '',
            userAgent: requestHeaders['user-agent'] || DEFAULT_USER_AGENT,
            resourceType: request.resourceType(),
          });

          await inspectTextBody(response);
        })();

        pendingBodyReads.add(promise);
        promise.finally(() => pendingBodyReads.delete(promise));
      });
    };

    context.on('page', observePage);

    await context.addInitScript(() => {
      try {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      } catch (_) {}
    });

    const page = await context.newPage();
    page.setDefaultTimeout(2500);
    page.setDefaultNavigationTimeout(Math.min(timeoutMs, 18000));
    observePage(page);

    let navigationError = '';
    try {
      await page.goto(rawUrl, {
        waitUntil: 'domcontentloaded',
        timeout: Math.min(timeoutMs, 18000),
      });
    } catch (error) {
      navigationError = error.message || String(error);
    }

    await page.waitForTimeout(1800);

    const playSelectors = [
      '.vjs-big-play-button',
      '.jw-icon-playback',
      '.plyr__control--overlaid',
      '[aria-label*="play" i]',
      '[title*="play" i]',
      'button[class*="play" i]',
      'video',
    ];

    const triggerPlayback = async (targetPage) => {
      const domUrls = await targetPage.evaluate(() => {
        const values = [];
        const push = (value) => {
          if (typeof value === 'string' && value) values.push(value);
        };

        document.querySelectorAll('video, audio, source').forEach((element) => {
          push(element.currentSrc);
          push(element.src);
          push(element.getAttribute('src'));
        });

        document.querySelectorAll('[data-src], [data-url], [data-file]').forEach((element) => {
          push(element.getAttribute('data-src'));
          push(element.getAttribute('data-url'));
          push(element.getAttribute('data-file'));
        });

        document.querySelectorAll('video').forEach((video) => {
          try {
            video.muted = true;
            video.autoplay = true;
            video.play().catch(() => {});
          } catch (_) {}
        });

        return values;
      }).catch(() => []);

      for (const value of domUrls) addCandidate({ url: value, resourceType: 'dom' });

      for (const selector of playSelectors) {
        try {
          const locator = targetPage.locator(selector).first();
          if (await locator.count()) {
            await locator.click({ force: true, timeout: 900 });
            await targetPage.waitForTimeout(350);
          }
        } catch {
          // El selector no existe o está cubierto.
        }
      }

      try {
        await targetPage.mouse.click(960, 540);
      } catch {}
    };

    for (const targetPage of context.pages()) {
      await triggerPlayback(targetPage);
    }

    await page.waitForTimeout(900);
    for (const targetPage of context.pages()) {
      observePage(targetPage);
      if (targetPage !== page) await triggerPlayback(targetPage);
    }

    await page.waitForTimeout(Math.min(NETWORK_SETTLE_MS, Math.max(2000, timeoutMs - (Date.now() - startedAt) - 1200)));
    await Promise.allSettled([...pendingBodyReads]);

    const frameUrls = [];
    for (const frame of page.frames()) {
      try {
        const values = await frame.evaluate(() => {
          const output = [];
          document.querySelectorAll('video, audio, source').forEach((element) => {
            if (element.currentSrc) output.push(element.currentSrc);
            if (element.src) output.push(element.src);
          });
          return output;
        });
        frameUrls.push(...values);
      } catch {
        // Frame de otro origen inaccesible; la red ya fue observada.
      }
    }

    for (const value of frameUrls) addCandidate({ url: value, resourceType: 'dom-frame' });

    const sortedCandidates = [...candidates.values()].sort((a, b) => b.score - a.score);
    const selected = sortedCandidates.find((candidate) => candidate.score > 20);

    if (!selected) {
      const failure = buildFailure(
        navigationError
          ? `La página no terminó de cargar (${navigationError}), y no emitió una solicitud HLS, DASH o MP4 reproducible.`
          : 'La página cargó y ejecutó JavaScript, pero no emitió una solicitud HLS, DASH o MP4 reproducible.',
        {
          resolverEngine,
          browserDiagnostics: {
            candidateCount: sortedCandidates.length,
            requestsObserved,
            pagesOpened,
            elapsedMs: Date.now() - startedAt,
          },
        },
      );
      cacheSet(rawUrl, failure);
      return failure;
    }

    const requestCookie = selected.cookie;
    let cookieHeader = requestCookie;
    if (!cookieHeader) {
      const cookies = await context.cookies(selected.url).catch(() => []);
      cookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
    }

    const sourceOrigin = new URL(rawUrl).origin;
    const mediaOrigin = new URL(selected.url).origin;
    const refererRequired = Boolean(selected.referer && sourceOrigin !== mediaOrigin);

    const result = {
      resolved: true,
      playbackUrl: selected.url,
      resolvedType: selected.type,
      cookieHeader,
      userAgent: selected.userAgent || DEFAULT_USER_AGENT,
      referer: selected.referer || rawUrl,
      resolverEngine,
      browserDiagnostics: {
        candidateCount: sortedCandidates.length,
        requestsObserved,
        pagesOpened,
        elapsedMs: Date.now() - startedAt,
        selectedScore: selected.score,
        selectedStatus: selected.status,
        selectedContentType: selected.contentType,
      },
      warning: refererRequired
        ? 'El servidor multimedia recibió Referer durante la detección. AVPlay puede reproducir si la URL o las cookies bastan; si exige Referer estricto, la fuente debe autorizar la TV o proporcionar un enlace directo.'
        : '',
      message: `Flujo ${selected.type.toUpperCase()} detectado después de ejecutar la página.`,
    };

    cacheSet(rawUrl, result);
    return result;
  } catch (error) {
    return buildFailure(
      `No fue posible ejecutar el navegador del backend: ${error.message}`,
      {
        resolverEngine,
        browserDiagnostics: {
          candidateCount: candidates.size,
          requestsObserved,
          pagesOpened,
          elapsedMs: Date.now() - startedAt,
        },
      },
    );
  } finally {
    try {
      await context?.close();
    } catch {}
    try {
      await browser?.close();
    } catch {}
  }
}
