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
import { webPageRouter } from './routes/webPageRoutes.js';

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

const corsOptions = {
  origin: '*',

  methods: [
    'GET',
    'HEAD',
    'POST',
    'PUT',
    'PATCH',
    'DELETE',
    'OPTIONS',
  ],

  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'Range',
  ],

  exposedHeaders: [
    'Content-Length',
    'Content-Range',
    'Accept-Ranges',
  ],

  // Algunas Smart TV antiguas tienen problemas con respuestas OPTIONS 204.
  optionsSuccessStatus: 200,
};

app.use(cors(corsOptions));

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
      webPageViewer: '/api/v1/web-pages/render?url=https://example.com',
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
app.use('/api/v1/web-pages', webPageRouter);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
