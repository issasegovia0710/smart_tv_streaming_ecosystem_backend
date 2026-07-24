import path from 'node:path';

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';

import { env } from './config/env.js';
import { assertDatabaseConnection } from './config/db.js';

import { categoryRouter } from './routes/categoryRoutes.js';
import { streamRouter } from './routes/streamRoutes.js';
import { uploadRouter } from './routes/uploadRoutes.js';
import { tvRouter } from './routes/tvRoutes.js';
import { mediaRouter } from './routes/mediaRoutes.js';

import { getCatalog } from './controllers/catalogController.js';
import { asyncHandler } from './utils/asyncHandler.js';
import {
  errorHandler,
  notFoundHandler,
} from './middleware/errorHandler.js';

export const app = express();

app.disable('x-powered-by');

app.use(
  helmet({
    crossOriginResourcePolicy: {
      policy: 'cross-origin',
    },
  }),
);

const allowedOrigins = env.corsOrigin
  .split(',')
  .map((item) => item.trim().replace(/\/+$/, ''))
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      // Aplicaciones de TV, Postman y peticiones servidor-servidor
      // pueden llegar sin encabezado Origin.
      if (!origin) {
        return callback(null, true);
      }

      const normalizedOrigin = origin.replace(/\/+$/, '');

      if (
        env.corsOrigin === '*' ||
        allowedOrigins.includes(normalizedOrigin)
      ) {
        return callback(null, true);
      }

      return callback(
        new Error(`Origen no permitido por CORS: ${origin}`),
      );
    },
    methods: [
      'GET',
      'POST',
      'PUT',
      'PATCH',
      'DELETE',
      'OPTIONS',
    ],
    allowedHeaders: ['Content-Type', 'Authorization', 'Range'],
    exposedHeaders: ['Content-Length', 'Content-Range', 'Accept-Ranges'],
    optionsSuccessStatus: 200,
  }),
);

app.use(morgan('combined'));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// En Vercel express.static() no conserva archivos subidos.
// Se mantiene para desarrollo local. En producción usa URL externa
// para las portadas, por ejemplo Cloudinary, S3 o Vercel Blob.
if (!process.env.VERCEL) {
  app.use(
    '/uploads',
    express.static(path.resolve('uploads'), {
      maxAge: '7d',
    }),
  );
}

// Ruta raíz: comprueba que Express arrancó sin tocar la base.
app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'smart-tv-streaming-api',
    message: 'API de streaming funcionando.',
    environment: process.env.VERCEL ? 'vercel' : 'local',
    endpoints: {
      health: '/api/v1/health',
      database: '/api/v1/health/database',
      catalog: '/api/v1/catalog',
      categories: '/api/v1/categories',
      streams: '/api/v1/streams',
      tvBootstrap: '/api/v1/tv/bootstrap',
    },
  });
});

// Salud básica: no consulta TiDB.
app.get('/api/v1/health', (req, res) => {
  res.json({
    ok: true,
    service: 'smart-tv-streaming-api',
    environment: process.env.VERCEL ? 'vercel' : 'local',
    timestamp: new Date().toISOString(),
  });
});

// Salud completa: prueba la conexión TLS con TiDB.
app.get(
  '/api/v1/health/database',
  asyncHandler(async (req, res) => {
    const database = await assertDatabaseConnection();

    res.json({
      ok: true,
      database: {
        name: database.databaseName,
        version: database.databaseVersion,
        host: env.dbHost,
        port: env.dbPort,
      },
      timestamp: new Date().toISOString(),
    });
  }),
);

app.get(
  '/api/v1/catalog',
  asyncHandler(getCatalog),
);

app.use('/api/v1/categories', categoryRouter);
app.use('/api/v1/streams', streamRouter);
app.use('/api/v1/uploads', uploadRouter);
app.use('/api/v1/tv', tvRouter);
app.use('/api/v1/media', mediaRouter);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
