import express from 'express';
// import { requirePermission, AuthenticatedRequest } from '../middleware/authMiddleware';
import { Request } from 'express';
import { supabaseAdmin } from '../lib/supabase';

const router = express.Router();

// GET: Retrieve Roles and their Permissions for a Gym
router.get('/:gymId', async (req: Request, res) => {
    try {
        const gymId = parseInt(req.params.gymId);

        // Fetch standard roles (gym_id is null) plus local gym roles
        const { data, error } = await supabaseAdmin
            .from('gym_roles')
            .select(`
                *,
                role_permissions (
                    permission_id,
                    permissions (
                        id, action, module, description
                    )
                )
            `)
            .or(`gym_id.eq.${gymId},gym_id.is.null`)
            .order('name');

        if (error) throw error;
        
        res.json(data);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// GET: Retrieve all available permissions
router.get('/permissions/all', async (req: Request, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from('permissions')
            .select('*')
            .order('module');

        if (error) throw error;
        
        res.json(data);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// POST: Create a new Permission
router.post('/permissions', async (req: Request, res) => {
    try {
        const { action, module, description } = req.body;
        if (!action || !module) {
            return res.status(400).json({ error: 'Action and module are required' });
        }
        const { data, error } = await supabaseAdmin
            .from('permissions')
            .insert({ action, module, description })
            .select()
            .single();

        if (error) throw error;
        res.status(201).json(data);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// PUT: Update a Permission
router.put('/permissions/:id', async (req: Request, res) => {
    try {
        const id = parseInt(req.params.id);
        const { action, module, description } = req.body;
        
        const { data, error } = await supabaseAdmin
            .from('permissions')
            .update({ action, module, description })
            .eq('id', id)
            .select()
            .single();

        if (error) throw error;
        res.json(data);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// DELETE: Delete a Permission
router.delete('/permissions/:id', async (req: Request, res) => {
    try {
        const id = parseInt(req.params.id);
        const { error } = await supabaseAdmin
            .from('permissions')
            .delete()
            .eq('id', id);

        if (error) throw error;
        res.status(204).send();
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// POST: Create a new Role
router.post('/', async (req: Request, res) => {
    try {
        const { gym_id, name, description, permission_ids } = req.body;

        if (!name || !gym_id) {
            return res.status(400).json({ error: 'Name and gym_id are required' });
        }

        // 1. Insert Role
        const { data: roleData, error: roleError } = await supabaseAdmin
            .from('gym_roles')
            .insert({ gym_id, name, description })
            .select()
            .single();

        if (roleError) throw roleError;

        // 2. Insert Permissions if provided
        if (permission_ids && permission_ids.length > 0) {
            const role_permissions = permission_ids.map((pid: number) => ({
                role_id: roleData.id,
                permission_id: pid
            }));
            
            const { error: permError } = await supabaseAdmin
                .from('role_permissions')
                .insert(role_permissions);
                
            if (permError) throw permError;
        }

        res.status(201).json(roleData);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// PUT: Update an existing Role & its permissions
router.put('/:roleId', async (req: Request, res) => {
    try {
        const roleId = parseInt(req.params.roleId);
        const { name, description, permission_ids } = req.body;

        // 1. Update Role fields
        const { data: roleData, error: roleError } = await supabaseAdmin
            .from('gym_roles')
            .update({ name, description })
            .eq('id', roleId)
            .select()
            .single();

        if (roleError) throw roleError;

        // 2. Update Permissions
        if (permission_ids !== undefined) {
            // Delete old permissions
            await supabaseAdmin
                .from('role_permissions')
                .delete()
                .eq('role_id', roleId);

            // Insert new permissions
            if (permission_ids.length > 0) {
                const role_permissions = permission_ids.map((pid: number) => ({
                    role_id: roleId,
                    permission_id: pid
                }));
                
                const { error: permError } = await supabaseAdmin
                    .from('role_permissions')
                    .insert(role_permissions);
                    
                if (permError) throw permError;
            }
        }

        res.json(roleData);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

export default router;
