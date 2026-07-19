import path from 'node:path';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { env } from './config/env.js';
import { categoryRouter } from './routes/categoryRoutes.js';
import { streamRouter } from './routes/streamRoutes.js';
import { uploadRouter } from './routes/uploadRoutes.js';
import { getCatalog } from './controllers/catalogController.js';
import { asyncHandler } from './utils/asyncHandler.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';

export const app = express();

app.disable('x-powered-by');
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({
  origin: env.corsOrigin === '*' ? true : env.corsOrigin.split(',').map((item) => item.trim()),
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
}));
app.use(morgan('combined'));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.resolve('uploads'), { maxAge: '7d' }));

app.get('/api/v1/health', (req, res) => {
  res.json({ ok: true, service: 'smart-tv-streaming-api', timestamp: new Date().toISOString() });
});
app.get('/api/v1/catalog', asyncHandler(getCatalog));
app.use('/api/v1/categories', categoryRouter);
app.use('/api/v1/streams', streamRouter);
app.use('/api/v1/uploads', uploadRouter);

app.use(notFoundHandler);
app.use(errorHandler);
