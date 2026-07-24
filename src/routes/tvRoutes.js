import { Router } from 'express';
import {
  getTvBootstrap,
  getTvChannelPlayback,
} from '../controllers/tvController.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const tvRouter = Router();

tvRouter.get('/bootstrap', asyncHandler(getTvBootstrap));
tvRouter.get('/channels/:id/play', asyncHandler(getTvChannelPlayback));
