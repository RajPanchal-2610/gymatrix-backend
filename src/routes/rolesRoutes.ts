import express from 'express';
import { authenticate, requirePermission, requireSuperAdmin } from '../middleware/authMiddleware';
import * as rolesController from '../controllers/rolesController';

const router = express.Router();

// GET: My Permissions (For Frontend RBAC)
router.get('/me/permissions', authenticate, rolesController.getMyPermissions);

// GET: My Role Info
router.get('/me/role', authenticate, rolesController.getMyRole);

// GET: Retrieve Roles and their Permissions for a Gym
router.get('/:gymId', ...requirePermission('view_roles'), rolesController.getRolesByGym);

// GET: Retrieve all available permissions
router.get('/permissions/all', ...requirePermission('view_permissions'), rolesController.getAllPermissions);

// POST: Create a new Permission
router.post('/permissions', ...requireSuperAdmin, rolesController.createPermission);

// PUT: Update a Permission
router.put('/permissions/:id', ...requireSuperAdmin, rolesController.updatePermission);

// DELETE: Delete a Permission
router.delete('/permissions/:id', ...requireSuperAdmin, rolesController.deletePermission);

// POST: Create a new Role
router.post('/', ...requirePermission('manage_roles'), rolesController.createRole);

// PUT: Update an existing Role & its permissions
router.put('/:roleId', ...requirePermission('manage_roles'), rolesController.updateRole);

export default router;
