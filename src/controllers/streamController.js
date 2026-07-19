import { pool } from '../config/db.js';
import { HttpError } from '../utils/httpError.js';
import { toSlug } from '../utils/slug.js';

const allowedTypes = new Set(['hls', 'mp4', 'rtmp', 'dash', 'other']);

function nullableDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new HttpError(400, `Fecha inválida: ${value}`);
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function normalizeStreamPayload(body, partial = false) {
  const output = {};

  if (!partial || body.title !== undefined) {
    const title = String(body.title ?? '').trim();
    if (!title) throw new HttpError(400, 'El título es obligatorio.');
    output.title = title;
    output.slug = toSlug(body.slug || title);
  }

  if (!partial || body.sourceUrl !== undefined) {
    const sourceUrl = String(body.sourceUrl ?? '').trim();
    if (!sourceUrl) throw new HttpError(400, 'sourceUrl es obligatorio.');
    output.source_url = sourceUrl;
  }

  if (body.playbackUrl !== undefined) {
    output.playback_url = String(body.playbackUrl ?? '').trim() || null;
  }

  if (body.description !== undefined) {
    output.description = String(body.description ?? '').trim() || null;
  }

  if (body.thumbnailUrl !== undefined) {
    output.thumbnail_url = String(body.thumbnailUrl ?? '').trim() || null;
  }

  if (body.streamType !== undefined) {
    const type = String(body.streamType).toLowerCase();
    if (!allowedTypes.has(type)) {
      throw new HttpError(400, `streamType inválido. Usa: ${[...allowedTypes].join(', ')}`);
    }
    output.stream_type = type;
  }

  if (body.isLive !== undefined) output.is_live = body.isLive ? 1 : 0;
  if (body.isActive !== undefined) output.is_active = body.isActive ? 1 : 0;
  if (body.startsAt !== undefined) output.starts_at = nullableDate(body.startsAt);
  if (body.endsAt !== undefined) output.ends_at = nullableDate(body.endsAt);

  if (body.metadata !== undefined) {
    output.metadata = body.metadata === null ? null : JSON.stringify(body.metadata);
  }

  return output;
}

async function replaceCategories(connection, streamId, categoryIds) {
  await connection.query('DELETE FROM stream_categories WHERE stream_id = ?', [streamId]);

  const ids = [...new Set((categoryIds ?? []).map(Number).filter(Number.isInteger))];
  for (let index = 0; index < ids.length; index += 1) {
    await connection.query(
      `INSERT INTO stream_categories (stream_id, category_id, sort_order)
       VALUES (?, ?, ?)`,
      [streamId, ids[index], (index + 1) * 10],
    );
  }
}

export async function listStreams(req, res) {
  const conditions = [];
  const values = [];

  if (req.query.categoryId) {
    conditions.push('sc.category_id = ?');
    values.push(Number(req.query.categoryId));
  }

  if (req.query.active !== undefined) {
    conditions.push('s.is_active = ?');
    values.push(req.query.active === 'true' ? 1 : 0);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const [rows] = await pool.query(
    `
      SELECT
        s.id,
        s.title,
        s.slug,
        s.description,
        s.source_url AS sourceUrl,
        COALESCE(s.playback_url, s.source_url) AS playbackUrl,
        s.stream_type AS streamType,
        s.thumbnail_url AS thumbnailUrl,
        s.is_live AS isLive,
        s.is_active AS isActive,
        s.starts_at AS startsAt,
        s.ends_at AS endsAt,
        s.metadata,
        s.created_at AS createdAt,
        s.updated_at AS updatedAt,
        COALESCE(
          JSON_ARRAYAGG(
            CASE WHEN c.id IS NULL THEN NULL ELSE JSON_OBJECT(
              'id', c.id,
              'name', c.name,
              'sortOrder', sc.sort_order
            ) END
          ),
          JSON_ARRAY()
        ) AS categories
      FROM streams s
      LEFT JOIN stream_categories sc ON sc.stream_id = s.id
      LEFT JOIN categories c ON c.id = sc.category_id
      ${where}
      GROUP BY s.id
      ORDER BY s.created_at DESC, s.id DESC
    `,
    values,
  );

  const data = rows.map((row) => {
    let categories = row.categories;
    if (typeof categories === 'string') {
      try {
        categories = JSON.parse(categories);
      } catch {
        categories = [];
      }
    }

    return {
      ...row,
      categories: Array.isArray(categories) ? categories.filter(Boolean) : [],
    };
  });

  res.json({ ok: true, data });
}

export async function getStream(req, res) {
  req.query = { ...req.query };
  const [rows] = await pool.query(
    `
      SELECT
        s.id,
        s.title,
        s.slug,
        s.description,
        s.source_url AS sourceUrl,
        COALESCE(s.playback_url, s.source_url) AS playbackUrl,
        s.stream_type AS streamType,
        s.thumbnail_url AS thumbnailUrl,
        s.is_live AS isLive,
        s.is_active AS isActive,
        s.starts_at AS startsAt,
        s.ends_at AS endsAt,
        s.metadata,
        s.created_at AS createdAt,
        s.updated_at AS updatedAt
      FROM streams s
      WHERE s.id = ?
    `,
    [req.params.id],
  );

  if (!rows.length) throw new HttpError(404, 'Contenido no encontrado.');

  const [categories] = await pool.query(
    `SELECT c.id, c.name, sc.sort_order AS sortOrder
     FROM stream_categories sc
     JOIN categories c ON c.id = sc.category_id
     WHERE sc.stream_id = ?
     ORDER BY sc.sort_order ASC`,
    [req.params.id],
  );

  res.json({ ok: true, data: { ...rows[0], categories } });
}

export async function createStream(req, res) {
  const payload = normalizeStreamPayload(req.body);
  payload.playback_url ??= null;
  payload.description ??= null;
  payload.thumbnail_url ??= null;
  payload.stream_type ??= 'hls';
  payload.is_live ??= 0;
  payload.is_active ??= 1;
  payload.starts_at ??= null;
  payload.ends_at ??= null;
  payload.metadata ??= null;

  if (payload.stream_type === 'rtmp' && !payload.playback_url) {
    throw new HttpError(
      400,
      'Para RTMP agrega playbackUrl HLS/DASH. Las TVs no garantizan reproducción RTMP directa.',
    );
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [result] = await connection.query(
      `INSERT INTO streams (
        title, slug, description, source_url, playback_url, stream_type,
        thumbnail_url, is_live, is_active, starts_at, ends_at, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        payload.title,
        payload.slug,
        payload.description,
        payload.source_url,
        payload.playback_url,
        payload.stream_type,
        payload.thumbnail_url,
        payload.is_live,
        payload.is_active,
        payload.starts_at,
        payload.ends_at,
        payload.metadata,
      ],
    );

    await replaceCategories(connection, result.insertId, req.body.categoryIds);
    await connection.commit();

    req.params.id = result.insertId;
    return getStream(req, res);
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function updateStream(req, res) {
  const payload = normalizeStreamPayload(req.body, true);
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    if (Object.keys(payload).length) {
      const entries = Object.entries(payload);
      const [result] = await connection.query(
        `UPDATE streams
         SET ${entries.map(([key]) => `${key} = ?`).join(', ')}
         WHERE id = ?`,
        [...entries.map(([, value]) => value), req.params.id],
      );

      if (!result.affectedRows) throw new HttpError(404, 'Contenido no encontrado.');
    } else {
      const [rows] = await connection.query('SELECT id FROM streams WHERE id = ?', [req.params.id]);
      if (!rows.length) throw new HttpError(404, 'Contenido no encontrado.');
    }

    if (req.body.categoryIds !== undefined) {
      await replaceCategories(connection, Number(req.params.id), req.body.categoryIds);
    }

    const [checkRows] = await connection.query(
      'SELECT stream_type AS streamType, source_url AS sourceUrl, playback_url AS playbackUrl FROM streams WHERE id = ?',
      [req.params.id],
    );

    const current = checkRows[0];
    if (current.streamType === 'rtmp' && !current.playbackUrl) {
      throw new HttpError(
        400,
        'Para RTMP agrega playbackUrl HLS/DASH. Las TVs no garantizan reproducción RTMP directa.',
      );
    }

    await connection.commit();
    return getStream(req, res);
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function deleteStream(req, res) {
  const [result] = await pool.query('DELETE FROM streams WHERE id = ?', [req.params.id]);
  if (!result.affectedRows) throw new HttpError(404, 'Contenido no encontrado.');
  res.status(204).send();
}
