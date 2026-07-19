import { Router } from 'express';
import { uploadThumbnail as uploadThumbnailController } from '../controllers/uploadController.js';
import { uploadThumbnail } from '../middleware/upload.js';

export const uploadRouter = Router();

uploadRouter.post('/thumbnail', uploadThumbnail.single('thumbnail'), uploadThumbnailController);
