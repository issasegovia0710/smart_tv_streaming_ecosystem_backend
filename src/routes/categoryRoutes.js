import { Router } from 'express';
import {
  createCategory,
  deleteCategory,
  getCategory,
  listCategories,
  reorderCategories,
  updateCategory,
} from '../controllers/categoryController.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const categoryRouter = Router();

categoryRouter.get('/', asyncHandler(listCategories));
categoryRouter.get('/:id', asyncHandler(getCategory));
categoryRouter.post('/', asyncHandler(createCategory));
categoryRouter.patch('/reorder', asyncHandler(reorderCategories));
categoryRouter.put('/:id', asyncHandler(updateCategory));
categoryRouter.delete('/:id', asyncHandler(deleteCategory));
