import multer from 'multer';
import { HttpError } from '../utils/httpError.js';

export function notFoundHandler(req, res) {
  res.status(404).json({
    ok: false,
    message: `Ruta no encontrada: ${req.method} ${req.originalUrl}`,
  });
}

export function errorHandler(error, req, res, next) {
  if (res.headersSent) {
    return next(error);
  }

  if (error instanceof multer.MulterError) {
    return res.status(400).json({
      ok: false,
      message: `Error de archivo: ${error.message}`,
    });
  }

  if (error?.code === 'ER_DUP_ENTRY') {
    return res.status(409).json({
      ok: false,
      message: 'Ya existe un registro con esos datos únicos.',
      details: error.sqlMessage,
    });
  }

  const status = error instanceof HttpError ? error.status : 500;

  if (status >= 500) {
    console.error(error);
  }

  return res.status(status).json({
    ok: false,
    message: error.message || 'Error interno del servidor.',
    ...(error.details ? { details: error.details } : {}),
  });
}
