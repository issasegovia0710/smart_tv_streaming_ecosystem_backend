import { pool } from '../config/db.js';
import { HttpError } from '../utils/httpError.js';
import { toSlug } from '../utils/slug.js';

function normalizeCategoryPayload(body, partial = false) {
  const output = {};

  if (!partial || body.name !== undefined) {
    const name = String(body.name ?? '').trim();
    if (!name) throw new HttpError(400, 'El nombre de la categoría es obligatorio.');
    output.name = name;
    output.slug = toSlug(body.slug || name);
  }

  if (body.description !== undefined) {
    output.description = String(body.description ?? '').trim() || null;
  }

  if (body.sortOrder !== undefined) {
    const value = Number(body.sortOrder);
    if (!Number.isInteger(value)) throw new HttpError(400, 'sortOrder debe ser entero.');
    output.sort_order = value;
  }

  if (body.isActive !== undefined) {
    output.is_active = body.isActive ? 1 : 0;
  }

  return output;
}

export async function listCategories(req, res) {
  const [rows] = await pool.query(`
    SELECT
      c.id,
      c.name,
      c.slug,
      c.description,
      c.sort_order AS sortOrder,
      c.is_active AS isActive,
      COUNT(sc.stream_id) AS streamCount,
      c.created_at AS createdAt,
      c.updated_at AS updatedAt
    FROM categories c
    LEFT JOIN stream_categories sc ON sc.category_id = c.id
    GROUP BY c.id
    ORDER BY c.sort_order ASC, c.id ASC
  `);

  res.json({ ok: true, data: rows });
}

export async function getCategory(req, res) {
  const [rows] = await pool.query(
    `SELECT id, name, slug, description, sort_order AS sortOrder,
            is_active AS isActive, created_at AS createdAt, updated_at AS updatedAt
     FROM categories WHERE id = ?`,
    [req.params.id],
  );

  if (!rows.length) throw new HttpError(404, 'Categoría no encontrada.');
  res.json({ ok: true, data: rows[0] });
}

export async function createCategory(req, res) {
  const payload = normalizeCategoryPayload(req.body);
  payload.description ??= null;
  payload.sort_order ??= 0;
  payload.is_active ??= 1;

  const [result] = await pool.query(
    `INSERT INTO categories (name, slug, description, sort_order, is_active)
     VALUES (?, ?, ?, ?, ?)`,
    [
      payload.name,
      payload.slug,
      payload.description,
      payload.sort_order,
      payload.is_active,
    ],
  );

  req.params.id = result.insertId;
  return getCategory(req, res);
}

export async function updateCategory(req, res) {
  const payload = normalizeCategoryPayload(req.body, true);
  const entries = Object.entries(payload);

  if (!entries.length) throw new HttpError(400, 'No hay campos para actualizar.');

  const [result] = await pool.query(
    `UPDATE categories
     SET ${entries.map(([key]) => `${key} = ?`).join(', ')}
     WHERE id = ?`,
    [...entries.map(([, value]) => value), req.params.id],
  );

  if (!result.affectedRows) throw new HttpError(404, 'Categoría no encontrada.');
  return getCategory(req, res);
}

export async function deleteCategory(req, res) {
  const [result] = await pool.query('DELETE FROM categories WHERE id = ?', [req.params.id]);
  if (!result.affectedRows) throw new HttpError(404, 'Categoría no encontrada.');
  res.status(204).send();
}

export async function reorderCategories(req, res) {
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!items.length) throw new HttpError(400, 'items debe contener categorías.');

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    for (const item of items) {
      const id = Number(item.id);
      const sortOrder = Number(item.sortOrder);
      if (!Number.isInteger(id) || !Number.isInteger(sortOrder)) {
        throw new HttpError(400, 'Cada elemento requiere id y sortOrder enteros.');
      }
      await connection.query(
        'UPDATE categories SET sort_order = ? WHERE id = ?',
        [sortOrder, id],
      );
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  return listCategories(req, res);
}
