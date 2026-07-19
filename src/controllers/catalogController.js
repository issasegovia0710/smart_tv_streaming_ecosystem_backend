import { pool } from '../config/db.js';

export async function getCatalog(req, res) {
  const [rows] = await pool.query(`
    SELECT
      c.id AS category_id,
      c.name AS category_name,
      c.slug AS category_slug,
      c.description AS category_description,
      c.sort_order AS category_sort_order,
      s.id AS stream_id,
      s.title AS stream_title,
      s.slug AS stream_slug,
      s.description AS stream_description,
      COALESCE(s.playback_url, s.source_url) AS playback_url,
      s.source_url,
      s.stream_type,
      s.thumbnail_url,
      s.is_live,
      s.starts_at,
      s.ends_at,
      sc.sort_order AS stream_sort_order
    FROM categories c
    LEFT JOIN stream_categories sc ON sc.category_id = c.id
    LEFT JOIN streams s
      ON s.id = sc.stream_id
      AND s.is_active = 1
      AND (s.starts_at IS NULL OR s.starts_at <= UTC_TIMESTAMP())
      AND (s.ends_at IS NULL OR s.ends_at >= UTC_TIMESTAMP())
    WHERE c.is_active = 1
    ORDER BY c.sort_order ASC, c.id ASC, sc.sort_order ASC, s.id ASC
  `);

  const categoryMap = new Map();

  for (const row of rows) {
    if (!categoryMap.has(row.category_id)) {
      categoryMap.set(row.category_id, {
        id: row.category_id,
        name: row.category_name,
        slug: row.category_slug,
        description: row.category_description,
        sortOrder: row.category_sort_order,
        items: [],
      });
    }

    if (row.stream_id) {
      categoryMap.get(row.category_id).items.push({
        id: row.stream_id,
        title: row.stream_title,
        slug: row.stream_slug,
        description: row.stream_description,
        playbackUrl: row.playback_url,
        sourceUrl: row.source_url,
        streamType: row.stream_type,
        thumbnailUrl: row.thumbnail_url,
        isLive: Boolean(row.is_live),
        startsAt: row.starts_at,
        endsAt: row.ends_at,
        sortOrder: row.stream_sort_order,
      });
    }
  }

  res.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=120');
  res.json({
    ok: true,
    generatedAt: new Date().toISOString(),
    data: [...categoryMap.values()],
  });
}
