import { Request, Response } from 'express';
import { supabaseAdmin } from '../lib/supabase';

// GET: Retrieve Staff for a Gym
export const getStaffByGym = async (req: Request, res: Response) => {
    try {
        const gymId = parseInt(req.params.gymId);

        const { data, error } = await supabaseAdmin
            .from('gym_staff')
            .select(`
                *,
                gym_roles (id, name)
            `)
            .eq('gym_id', gymId)
            .eq('is_deleted', false)
            .order('created_at', { ascending: false });

        if (error) throw error;

        res.json(data);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
};

// POST: Create New Staff (Includes optional Supabase Auth User)
export const createStaff = async (req: Request, res: Response) => {
    try {
        const { gym_id, email, password, full_name, role_id, phone, salary, allow_login } = req.body;

        if (!gym_id || !role_id || !full_name) {
            return res.status(400).json({ error: 'Missing required fields: gym_id, role_id, full_name' });
        }

        let userId = null;

        // 1. Create Auth User using Admin API if allow_login is true
        if (allow_login) {
            if (!email || !password) {
                return res.status(400).json({ error: 'Email and password are required for login access' });
            }

            const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
                email,
                password,
                email_confirm: true // Force confirm email so they can log in immediately
            });

            if (authError || !authData.user) {
                return res.status(400).json({ error: authError?.message || 'Failed to create user account' });
            }

            userId = authData.user.id;
        }

        // 2. Insert into gym_staff
        const newStaff = {
            gym_id,
            user_id: userId,
            full_name,
            email,
            phone,
            salary,
            role_id,
            status: 'active',
            is_active: true,
            allow_login: !!allow_login
        };

        const { data: staffData, error: staffError } = await supabaseAdmin
            .from('gym_staff')
            .insert(newStaff)
            .select()
            .single();

        if (staffError) {
            // Rollback auth user creation if staff insert fails and we created one
            if (userId) {
                await supabaseAdmin.auth.admin.deleteUser(userId);
            }
            return res.status(400).json({ error: staffError.message });
        }

        res.status(201).json(staffData);

    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
};

// PUT: Update Staff Member
export const updateStaff = async (req: Request, res: Response) => {
    try {
        const staffId = parseInt(req.params.id);
        const { email, password, full_name, role_id, phone, salary, allow_login, status } = req.body;

        // 1. Get existing staff record
        const { data: existingStaff, error: fetchError } = await supabaseAdmin
            .from('gym_staff')
            .select('*')
            .eq('id', staffId)
            .single();

        if (fetchError || !existingStaff) {
            return res.status(404).json({ error: 'Staff member not found' });
        }

        let userId = existingStaff.user_id;

        // 2. Handle Login Changes
        if (allow_login) {
            if (userId) {
                // Update existing user
                const updateData: any = {};
                if (email) updateData.email = email;
                if (password) updateData.password = password;

                if (Object.keys(updateData).length > 0) {
                    const { error: authError } = await supabaseAdmin.auth.admin.updateUserById(userId, updateData);
                    if (authError) return res.status(400).json({ error: authError.message });
                }
            } else {
                // Create new user if they don't have one
                if (!email || !password) {
                    return res.status(400).json({ error: 'Email and password are required to enable login' });
                }
                const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
                    email,
                    password,
                    email_confirm: true
                });
                if (authError || !authData.user) return res.status(400).json({ error: authError?.message || 'Failed to create user account' });
                userId = authData.user.id;
            }
        }

        // 3. Update gym_staff
        const updates: any = {
            full_name,
            email,
            phone,
            salary,
            role_id,
            status,
            user_id: userId,
            allow_login: !!allow_login
        };

        const { data: staffData, error: staffError } = await supabaseAdmin
            .from('gym_staff')
            .update(updates)
            .eq('id', staffId)
            .select()
            .single();

        if (staffError) return res.status(400).json({ error: staffError.message });

        res.json(staffData);

    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
};
