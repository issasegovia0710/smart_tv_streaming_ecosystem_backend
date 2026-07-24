import { Router } from 'express';

import { renderWebPage } from '../controllers/webPageController.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const webPageRouter = Router();

webPageRouter.get('/render', asyncHandler(renderWebPage));
