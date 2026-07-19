import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import { env } from '../config/env.js';
import { HttpError } from '../utils/httpError.js';

const allowedMimeTypes = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

const storage = multer.diskStorage({
  destination: path.resolve('uploads'),
  filename: (req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase() || '.bin';
    callback(null, `${Date.now()}-${crypto.randomUUID()}${extension}`);
  },
});

export const uploadThumbnail = multer({
  storage,
  limits: {
    fileSize: env.uploadMaxMb * 1024 * 1024,
  },
  fileFilter: (req, file, callback) => {
    if (!allowedMimeTypes.has(file.mimetype)) {
      return callback(new HttpError(400, 'Solo se permiten imágenes JPG, PNG o WebP.'));
    }
    callback(null, true);
  },
});
