import { Router } from 'express';
import {
  createStream,
  deleteStream,
  getStream,
  listStreams,
  updateStream,
} from '../controllers/streamController.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const streamRouter = Router();

streamRouter.get('/', asyncHandler(listStreams));
streamRouter.get('/:id', asyncHandler(getStream));
streamRouter.post('/', asyncHandler(createStream));
streamRouter.put('/:id', asyncHandler(updateStream));
streamRouter.delete('/:id', asyncHandler(deleteStream));
