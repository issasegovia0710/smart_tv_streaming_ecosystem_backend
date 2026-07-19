import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import slugify from 'slugify';

import { pool } from '../src/config/db.js';

function parseArgs(argv) {
  const args = {
    source: null,
    group: null,
    includePlaceholders: false,
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];

    if (!args.source && !value.startsWith('--')) {
      args.source = value;
      continue;
    }

    if (value === '--group') {
      args.group = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (value === '--include-placeholders') {
      args.includePlaceholders = true;
      continue;
    }

    if (value === '--dry-run') {
      args.dryRun = true;
      continue;
    }

    throw new Error(`Argumento no reconocido: ${value}`);
  }

  if (!args.source) {
    throw new Error(
      'Uso: node scripts/import_m3u8.mjs <archivo-o-url> [--group "Deportivos"] [--include-placeholders] [--dry-run]',
    );
  }

  return args;
}

async function loadText(source) {
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source, {
      headers: {
        Accept: 'application/x-mpegURL, application/vnd.apple.mpegurl, text/plain',
        'User-Agent': 'Smart-TV-Streaming-Importer/1.0',
      },
    });

    if (!response.ok) {
      throw new Error(`No se pudo descargar la lista: HTTP ${response.status}`);
    }

    return response.text();
  }

  return fs.readFile(source, 'utf8');
}

function parseAttributes(extinfLine) {
  const attributes = {};
  const regex = /([\w-]+)="([^"]*)"/g;
  let match;

  while ((match = regex.exec(extinfLine)) !== null) {
    attributes[match[1]] = match[2];
  }

  return attributes;
}

function parseM3u(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const entries = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (!line.startsWith('#EXTINF:')) continue;

    const attributes = parseAttributes(line);
    const commaIndex = line.indexOf(',');
    const title =
      commaIndex >= 0
        ? line.slice(commaIndex + 1).trim()
        : attributes['tvg-name']?.trim();

    let url = null;

    for (let next = index + 1; next < lines.length; next += 1) {
      if (lines[next].startsWith('#')) continue;
      url = lines[next];
      index = next;
      break;
    }

    if (!title || !url) continue;

    entries.push({
      title,
      url,
      group: attributes['group-title']?.trim() || 'Sin categoría',
      logo: attributes['tvg-logo']?.trim() || null,
      tvgId: attributes['tvg-id']?.trim() || null,
      tvgName: attributes['tvg-name']?.trim() || title,
    });
  }

  return entries;
}

function containsRuntimePlaceholders(url) {
  return /\[(?:[A-Z_%0-9]+)\]/i.test(url);
}

function detectStreamType(url) {
  const value = url.toLowerCase();

  if (value.startsWith('rtmp://') || value.startsWith('rtmps://')) return 'rtmp';
  if (value.includes('.mpd')) return 'dash';
  if (value.includes('.mp4')) return 'mp4';
  if (value.includes('.m3u8')) return 'hls';

  return 'other';
}

function makeSlug(value) {
  return slugify(value, {
    lower: true,
    strict: true,
    locale: 'es',
    trim: true,
  }) || 'contenido';
}

function makeStreamSlug(entry) {
  const hash = crypto
    .createHash('sha1')
    .update(entry.url)
    .digest('hex')
    .slice(0, 10);

  return `${makeSlug(entry.title)}-${hash}`.slice(0, 200);
}

async function upsertCategory(connection, name, sortOrder) {
  const slug = makeSlug(name);

  await connection.query(
    `
      INSERT INTO categories (
        name,
        slug,
        description,
        sort_order,
        is_active
      )
      VALUES (?, ?, ?, ?, 1)
      ON DUPLICATE KEY UPDATE
        name = VALUES(name),
        description = VALUES(description),
        sort_order = VALUES(sort_order),
        is_active = 1
    `,
    [
      name,
      slug,
      'Categoría importada desde una lista M3U.',
      sortOrder,
    ],
  );

  const [[category]] = await connection.query(
    'SELECT id FROM categories WHERE slug = ? LIMIT 1',
    [slug],
  );

  if (!category) {
    throw new Error(`No se pudo recuperar la categoría: ${name}`);
  }

  return category.id;
}

async function upsertStream(connection, entry) {
  const metadata = JSON.stringify({
    importedFrom: 'TDTChannels M3U',
    tvgId: entry.tvgId,
    tvgName: entry.tvgName,
    groupTitle: entry.group,
  });

  const [[existing]] = await connection.query(
    `
      SELECT id
      FROM streams
      WHERE source_url = ?
      LIMIT 1
    `,
    [entry.url],
  );

  if (existing) {
    await connection.query(
      `
        UPDATE streams
        SET
          title = ?,
          description = ?,
          playback_url = ?,
          stream_type = ?,
          thumbnail_url = ?,
          is_live = 1,
          is_active = 1,
          metadata = ?
        WHERE id = ?
      `,
      [
        entry.title,
        `Canal en vivo importado desde la categoría ${entry.group}.`,
        entry.url,
        detectStreamType(entry.url),
        entry.logo,
        metadata,
        existing.id,
      ],
    );

    return existing.id;
  }

  const slug = makeStreamSlug(entry);

  const [result] = await connection.query(
    `
      INSERT INTO streams (
        title,
        slug,
        description,
        source_url,
        playback_url,
        stream_type,
        thumbnail_url,
        is_live,
        is_active,
        metadata
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?)
      ON DUPLICATE KEY UPDATE
        title = VALUES(title),
        description = VALUES(description),
        source_url = VALUES(source_url),
        playback_url = VALUES(playback_url),
        stream_type = VALUES(stream_type),
        thumbnail_url = VALUES(thumbnail_url),
        is_live = 1,
        is_active = 1,
        metadata = VALUES(metadata),
        id = LAST_INSERT_ID(id)
    `,
    [
      entry.title,
      slug,
      `Canal en vivo importado desde la categoría ${entry.group}.`,
      entry.url,
      entry.url,
      detectStreamType(entry.url),
      entry.logo,
      metadata,
    ],
  );

  return result.insertId;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const text = await loadText(args.source);

  let entries = parseM3u(text);

  if (args.group) {
    const requested = args.group.toLocaleLowerCase('es');
    entries = entries.filter(
      (entry) => entry.group.toLocaleLowerCase('es') === requested,
    );
  }

  const skippedPlaceholders = entries.filter((entry) =>
    containsRuntimePlaceholders(entry.url),
  );

  if (!args.includePlaceholders) {
    entries = entries.filter(
      (entry) => !containsRuntimePlaceholders(entry.url),
    );
  }

  const uniqueByUrl = new Map();

  for (const entry of entries) {
    uniqueByUrl.set(entry.url, entry);
  }

  entries = [...uniqueByUrl.values()];

  const groups = [...new Set(entries.map((entry) => entry.group))].sort(
    (a, b) => a.localeCompare(b, 'es'),
  );

  console.log(`Entradas listas para importar: ${entries.length}`);
  console.log(`Categorías: ${groups.length}`);

  if (skippedPlaceholders.length && !args.includePlaceholders) {
    console.log(
      `Omitidas por usar marcadores dinámicos: ${skippedPlaceholders.length}`,
    );
  }

  if (args.dryRun) {
    console.table(
      entries.slice(0, 20).map((entry) => ({
        title: entry.title,
        group: entry.group,
        type: detectStreamType(entry.url),
        url: entry.url.slice(0, 80),
      })),
    );
    return;
  }

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const categoryIds = new Map();

    for (let index = 0; index < groups.length; index += 1) {
      const group = groups[index];
      const categoryId = await upsertCategory(
        connection,
        group,
        (index + 1) * 10,
      );
      categoryIds.set(group, categoryId);
    }

    let imported = 0;

    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const streamId = await upsertStream(connection, entry);
      const categoryId = categoryIds.get(entry.group);

      await connection.query(
        `
          INSERT INTO stream_categories (
            stream_id,
            category_id,
            sort_order
          )
          VALUES (?, ?, ?)
          ON DUPLICATE KEY UPDATE
            sort_order = VALUES(sort_order)
        `,
        [streamId, categoryId, (index + 1) * 10],
      );

      imported += 1;

      if (imported % 50 === 0 || imported === entries.length) {
        console.log(`Procesados ${imported}/${entries.length}`);
      }
    }

    await connection.commit();

    console.log('');
    console.log('Importación terminada correctamente.');
    console.log(`Canales procesados: ${imported}`);
    console.log(`Categorías procesadas: ${groups.length}`);
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
    await pool.end();
  }
}

main().catch(async (error) => {
  console.error('');
  console.error('Falló la importación:');
  console.error(error);

  try {
    await pool.end();
  } catch {
    // No hacer nada.
  }

  process.exitCode = 1;
});
