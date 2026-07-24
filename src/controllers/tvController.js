import { pool } from '../config/db.js';
import { resolveWebMedia } from './streamTestController.js';
import { HttpError } from '../utils/httpError.js';

const DEFAULT_APP_VERSION = '1.6.0';
const DEFAULT_REFRESH_INTERVAL_MS = 180000;

function parseVersion(value) {
  return String(value || '0')
    .split('.')
    .slice(0, 4)
    .map((part) => Number.parseInt(part, 10) || 0);
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  const length = Math.max(a.length, b.length);

  for (let index = 0; index < length; index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }

  return 0;
}

async function readContentVersion() {
  const [[row]] = await pool.query(`
    SELECT GREATEST(
      COALESCE(UNIX_TIMESTAMP((SELECT MAX(updated_at) FROM streams)), 0),
      COALESCE(UNIX_TIMESTAMP((SELECT MAX(updated_at) FROM categories)), 0)
    ) AS content_version
  `);

  return String(row?.content_version || Math.floor(Date.now() / 1000));
}

function isDirectMediaType(streamType, playbackUrl) {
  const type = String(streamType || '').toLowerCase();
  const url = String(playbackUrl || '').toLowerCase();

  return (
    ['hls', 'dash', 'mp4'].includes(type) ||
    /\.m3u8(?:$|[?#])/.test(url) ||
    /\.mpd(?:$|[?#])/.test(url) ||
    /\.mp4(?:$|[?#])/.test(url)
  );
}

function directType(streamType, playbackUrl) {
  const type = String(streamType || '').toLowerCase();
  const url = String(playbackUrl || '').toLowerCase();

  if (type === 'hls' || /\.m3u8(?:$|[?#])/.test(url)) return 'hls';
  if (type === 'dash' || /\.mpd(?:$|[?#])/.test(url)) return 'dash';
  return 'mp4';
}

export async function getTvBootstrap(req, res) {
  const installedAppVersion = String(req.query.appVersion || '0.0.0');
  const installedContentVersion = String(req.query.contentVersion || '0');
  const latestAppVersion = String(
    process.env.TV_LATEST_APP_VERSION || DEFAULT_APP_VERSION,
  );
  const minimumAppVersion = String(
    process.env.TV_MINIMUM_APP_VERSION || '1.5.0',
  );
  const contentVersion = await readContentVersion();

  res.set('Cache-Control', 'no-store, max-age=0');
  res.json({
    ok: true,
    data: {
      platform: 'samsung-tizen',
      contentVersion,
      contentUpdateAvailable: contentVersion !== installedContentVersion,
      latestAppVersion,
      minimumAppVersion,
      appUpdateAvailable:
        compareVersions(latestAppVersion, installedAppVersion) > 0,
      appUpdateRequired:
        compareVersions(minimumAppVersion, installedAppVersion) > 0,
      canInstallBinaryFromBackend: false,
      binaryUpdateMode: 'samsung-store-or-sdb',
      updateMessage:
        process.env.TV_UPDATE_MESSAGE ||
        'Los canales y la configuración se actualizan desde el servidor.',
      catalogUrl: '/api/v1/catalog',
      refreshIntervalMs: Math.max(
        60000,
        Number(
          process.env.TV_CONTENT_REFRESH_INTERVAL_MS ||
          DEFAULT_REFRESH_INTERVAL_MS,
        ),
      ),
      generatedAt: new Date().toISOString(),
    },
  });
}

export async function getTvChannelPlayback(req, res) {
  const [rows] = await pool.query(
    `
      SELECT
        id,
        title,
        source_url AS sourceUrl,
        playback_url AS explicitPlaybackUrl,
        COALESCE(playback_url, source_url) AS playbackUrl,
        stream_type AS streamType,
        is_active AS isActive
      FROM streams
      WHERE id = ?
      LIMIT 1
    `,
    [req.params.id],
  );

  if (!rows.length || !rows[0].isActive) {
    throw new HttpError(404, 'Canal no encontrado o desactivado.');
  }

  const stream = rows[0];
  const playbackUrl = String(stream.playbackUrl || '').trim();

  if (isDirectMediaType(stream.streamType, playbackUrl)) {
    return res.json({
      ok: true,
      data: {
        resolved: true,
        streamId: stream.id,
        title: stream.title,
        playbackUrl,
        resolvedType: directType(stream.streamType, playbackUrl),
        resolverEngine: stream.explicitPlaybackUrl
          ? 'configured-playback-url'
          : 'direct-source',
        cookieHeader: '',
        userAgent: '',
        referer: stream.sourceUrl || '',
        message: 'Flujo directo listo para reproducir.',
      },
    });
  }

  if (String(stream.streamType || '').toLowerCase() !== 'web') {
    throw new HttpError(
      422,
      'El canal no tiene una URL HLS, DASH o MP4 reproducible.',
    );
  }

  const resolution = await resolveWebMedia(stream.sourceUrl, {
    forceRefresh: req.query.refresh === '1' || req.query.refresh === 'true',
  });

  res.set('Cache-Control', 'no-store, max-age=0');
  return res.json({
    ok: true,
    data: {
      ...resolution,
      streamId: stream.id,
      title: stream.title,
    },
  });
}
