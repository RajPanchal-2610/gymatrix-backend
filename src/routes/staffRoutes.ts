import express from 'express';
import { requirePermission } from '../middleware/authMiddleware';
import * as staffController from '../controllers/staffController';

const router = express.Router();

// GET: Retrieve Staff for a Gym
router.get('/:gymId', ...requirePermission('view_staff'), staffController.getStaffByGym);

// POST: Create New Staff (Includes optional Supabase Auth User)
router.post('/', ...requirePermission('add_staff'), staffController.createStaff);

// PUT: Update Staff Member
router.put('/:id', ...requirePermission('edit_staff'), staffController.updateStaff);

export default router;
