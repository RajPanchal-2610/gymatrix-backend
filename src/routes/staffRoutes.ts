import express from 'express';
// import { requirePermission, AuthenticatedRequest } from '../middleware/authMiddleware';
// Temporarily using standard Request since we aren't using the auth middleware
import { Request } from 'express';
import { supabaseAdmin } from '../lib/supabase';

const router = express.Router();

// GET: Retrieve Staff for a Gym
router.get('/:gymId', async (req: Request, res) => {
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
});

// POST: Create New Staff (Includes creating Supabase Auth User)
router.post('/', async (req: Request, res) => {
    try {
        const { gym_id, email, password, full_name, role_id, phone, salary } = req.body;

        if (!email || !password || !gym_id || !role_id || !full_name) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        // 1. Create Auth User using Admin API
        const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
            email,
            password,
            email_confirm: true // Force confirm email so they can log in immediately
        });

        if (authError || !authData.user) {
            return res.status(400).json({ error: authError?.message || 'Failed to create user account' });
        }

        const userId = authData.user.id;

        // 2. Insert into gym_staff
        const newStaff = {
            gym_id,
            user_id: userId,
            full_name,
            phone,
            salary,
            role_id,
            status: 'Active',
            is_active: true
        };

        const { data: staffData, error: staffError } = await supabaseAdmin
            .from('gym_staff')
            .insert(newStaff)
            .select()
            .single();

        if (staffError) {
            // Rollback auth user creation if staff insert fails
            await supabaseAdmin.auth.admin.deleteUser(userId);
            return res.status(400).json({ error: staffError.message });
        }

        res.status(201).json(staffData);

    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

export default router;
