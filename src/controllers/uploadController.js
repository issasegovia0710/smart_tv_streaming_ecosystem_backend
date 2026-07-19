import { env } from '../config/env.js';
import { HttpError } from '../utils/httpError.js';

export function uploadThumbnail(req, res) {
  if (!req.file) throw new HttpError(400, 'Selecciona una imagen.');

  const url = `${env.publicBaseUrl.replace(/\/$/, '')}/uploads/${req.file.filename}`;

  res.status(201).json({
    ok: true,
    data: {
      url,
      filename: req.file.filename,
      size: req.file.size,
      mimeType: req.file.mimetype,
    },
  });
}
