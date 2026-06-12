import { Request, Response } from 'express';
import { AuthenticatedRequest } from '../middleware/authMiddleware';
import { supabaseAdmin } from '../lib/supabase';

// GET: My Permissions (For Frontend RBAC)
export const getMyPermissions = (req: AuthenticatedRequest, res: Response) => {
    res.json({
        permissions: req.permissions || [],
        gymId: req.gymId
    });
};

// GET: My Role Info
export const getMyRole = async (req: AuthenticatedRequest, res: Response) => {
    try {
        if (req.isSuperAdmin) {
            return res.json({ name: 'Super Admin', isOwner: false, staff_id: null });
        }

        // Check if the user is a Gym Owner
        const { data: gymData } = await supabaseAdmin
            .from('gyms')
            .select('id')
            .eq('owner_id', req.user.id)
            .limit(1)
            .maybeSingle();

        const isOwner = !!gymData;

        // Check if the user has an active staff record
        const { data: staffData } = await supabaseAdmin
            .from('gym_staff')
            .select('id, gym_roles(id, name, description)')
            .eq('user_id', req.user.id)
            .eq('is_deleted', false)
            .eq('status', 'active')
            .eq('allow_login', true)
            .maybeSingle();

        const hasStaffRecord = !!staffData;

        // If currently acting as Owner
        if (req.permissions?.includes('*')) {
            const staffRoles = staffData?.gym_roles as any;
            const staffRoleName = Array.isArray(staffRoles) ? staffRoles[0]?.name : staffRoles?.name;
            return res.json({
                name: 'Owner',
                description: 'Gym Owner with full control',
                isOwner: true,
                staff_id: staffData?.id || null,
                hasStaffRecord,
                staffRoleName: staffRoleName || null
            });
        }

        // Currently acting as staff/trainer
        const { data, error } = await supabaseAdmin
            .from('gym_staff')
            .select('id, gym_roles(id, name, description)')
            .eq('id', req.staffId)
            .single();

        if (error) throw error;

        const gymRoles = data?.gym_roles as any;
        const staffRoleObj = Array.isArray(gymRoles) ? gymRoles[0] : gymRoles;

        res.json({
            ...(staffRoleObj || { name: 'Staff' }),
            staff_id: data?.id,
            isOwner,
            hasStaffRecord,
            staffRoleName: staffRoleObj?.name || null
        });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
};

// GET: Retrieve Roles and their Permissions for a Gym
export const getRolesByGym = async (req: Request, res: Response) => {
    try {
        const gymId = parseInt(req.params.gymId);

        // Fetch standard roles (gym_id is null) plus local gym roles
        const { data, error } = await supabaseAdmin
            .from('gym_roles')
            .select(`
                *,
                gym_role_permissions (
                    permission_id,
                    permissions (
                        id, action, description, feature_id,
                        features (id, name, key)
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
};

// GET: Retrieve all available permissions
export const getAllPermissions = async (req: Request, res: Response) => {
    try {
        const { data, error } = await supabaseAdmin
            .from('permissions')
            .select(`
                *,
                features (
                    id, name, key
                )
            `);

        if (error) throw error;

        res.json(data);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
};

// POST: Create a new Permission
export const createPermission = async (req: Request, res: Response) => {
    try {
        const { action, feature_id, description } = req.body;
        if (!action || !feature_id) {
            return res.status(400).json({ error: 'Action and feature_id are required' });
        }
        const { data, error } = await supabaseAdmin
            .from('permissions')
            .insert({ action, feature_id, description })
            .select()
            .single();

        if (error) throw error;
        res.status(201).json(data);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
};

// PUT: Update a Permission
export const updatePermission = async (req: Request, res: Response) => {
    try {
        const id = parseInt(req.params.id);
        const { action, feature_id, description } = req.body;

        const { data, error } = await supabaseAdmin
            .from('permissions')
            .update({ action, feature_id, description })
            .eq('id', id)
            .select()
            .single();

        if (error) throw error;
        res.json(data);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
};

// DELETE: Delete a Permission
export const deletePermission = async (req: Request, res: Response) => {
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
};

// POST: Create a new Role
export const createRole = async (req: Request, res: Response) => {
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
                permission_id: pid,
                gym_id: gym_id // Added gym_id
            }));

            const { error: permError } = await supabaseAdmin
                .from('gym_role_permissions')
                .insert(role_permissions);

            if (permError) throw permError;
        }

        res.status(201).json(roleData);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
};

// PUT: Update an existing Role & its permissions
export const updateRole = async (req: Request, res: Response) => {
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
                .from('gym_role_permissions')
                .delete()
                .eq('role_id', roleId);

            // Insert new permissions
            if (permission_ids.length > 0) {
                // We need gym_id for the insert. Since it's an update, let's use the roleData's gym_id
                const role_permissions = permission_ids.map((pid: number) => ({
                    role_id: roleId,
                    permission_id: pid,
                    gym_id: roleData.gym_id
                }));

                const { error: permError } = await supabaseAdmin
                    .from('gym_role_permissions')
                    .insert(role_permissions);

                if (permError) throw permError;
            }
        }

        res.json(roleData);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
};
