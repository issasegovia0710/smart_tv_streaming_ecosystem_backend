import { Router } from 'express';

import { proxyMedia } from '../services/mediaGateway.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const mediaRouter = Router();

mediaRouter.get('/proxy/:token', asyncHandler(proxyMedia));
mediaRouter.head('/proxy/:token', asyncHandler(proxyMedia));
