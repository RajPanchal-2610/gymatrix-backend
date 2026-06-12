import { Request, Response } from 'express';
import { supabaseAdmin } from '../lib/supabase';

// GET: Retrieve Staff for a Gym
export const getStaffByGym = async (req: Request, res: Response) => {
    try {
        const gymId = parseInt(req.params.gymId);

        const { data: staffData, error: staffError } = await supabaseAdmin
            .from('gym_staff')
            .select(`
                *,
                gym_roles (id, name)
            `)
            .eq('gym_id', gymId)
            .eq('is_deleted', false)
            .order('created_at', { ascending: false });

        if (staffError) throw staffError;

        if (!staffData || staffData.length === 0) {
            return res.json([]);
        }

        // Fetch profiles for linked user accounts to get updated name, email, and phone
        const userIds = staffData
            .map((s: any) => s.user_id)
            .filter((uid: any) => uid !== null);

        let profileMap = new Map();

        if (userIds.length > 0) {
            const { data: profileData, error: profileError } = await supabaseAdmin
                .from('profiles')
                .select('user_id, full_name, email, phone')
                .in('user_id', userIds);

            if (!profileError && profileData) {
                profileData.forEach((p: any) => {
                    profileMap.set(p.user_id, p);
                });
            }
        }

        // Map updated profile details back to gym_staff response fields
        const mappedData = staffData.map((staff: any) => {
            if (staff.user_id && profileMap.has(staff.user_id)) {
                const profile = profileMap.get(staff.user_id);
                return {
                    ...staff,
                    full_name: profile.full_name || staff.full_name,
                    email: profile.email || staff.email,
                    phone: profile.phone || staff.phone
                };
            }
            return staff;
        });

        res.json(mappedData);
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
        let createdNewUser = false;

        // 1. Create Auth User using Admin API if allow_login is true
        if (allow_login) {
            if (!email) {
                return res.status(400).json({ error: 'Email is required for login access' });
            }

            // Check if user already exists in profiles
            const { data: existingProfile } = await supabaseAdmin
                .from('profiles')
                .select('user_id')
                .eq('email', email.trim().toLowerCase())
                .maybeSingle();

            if (existingProfile) {
                userId = existingProfile.user_id;
            } else {
                // Check if user exists in auth directly by listing users (fallback)
                const { data: authUsers, error: listError } = await supabaseAdmin.auth.admin.listUsers();
                if (!listError && authUsers?.users) {
                    const foundUser = authUsers.users.find(u => u.email?.toLowerCase() === email.trim().toLowerCase());
                    if (foundUser) {
                        userId = foundUser.id;
                    }
                }
            }

            if (!userId) {
                if (!password) {
                    return res.status(400).json({ error: 'Password is required for new login account' });
                }
                const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
                    email: email.trim().toLowerCase(),
                    password,
                    email_confirm: true // Force confirm email so they can log in immediately
                });

                if (authError || !authData.user) {
                    return res.status(400).json({ error: authError?.message || 'Failed to create user account' });
                }

                userId = authData.user.id;
                createdNewUser = true;
            }
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
            // Rollback auth user creation if staff insert fails and we created a new one
            if (userId && createdNewUser) {
                await supabaseAdmin.auth.admin.deleteUser(userId);
            }
            return res.status(400).json({ error: staffError.message });
        }

        // Create profile in profiles table for staff if userId exists
        if (userId) {
            const { error: profileError } = await supabaseAdmin
                .from('profiles')
                .upsert({
                    user_id: userId,
                    full_name,
                    email,
                    phone
                }, { onConflict: 'user_id' });

            if (profileError) {
                console.error("Error creating profile for staff:", profileError.message);
            }
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
                if (!email) {
                    return res.status(400).json({ error: 'Email is required to enable login' });
                }

                // Check if user already exists
                let existingUserId = null;
                const { data: existingProfile } = await supabaseAdmin
                    .from('profiles')
                    .select('user_id')
                    .eq('email', email.trim().toLowerCase())
                    .maybeSingle();

                if (existingProfile) {
                    existingUserId = existingProfile.user_id;
                } else {
                    const { data: authUsers, error: listError } = await supabaseAdmin.auth.admin.listUsers();
                    if (!listError && authUsers?.users) {
                        const foundUser = authUsers.users.find(u => u.email?.toLowerCase() === email.trim().toLowerCase());
                        if (foundUser) {
                            existingUserId = foundUser.id;
                        }
                    }
                }

                if (existingUserId) {
                    userId = existingUserId;
                } else {
                    if (!password) {
                        return res.status(400).json({ error: 'Password is required to enable login' });
                    }
                    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
                        email: email.trim().toLowerCase(),
                        password,
                        email_confirm: true
                    });
                    if (authError || !authData.user) return res.status(400).json({ error: authError?.message || 'Failed to create user account' });
                    userId = authData.user.id;
                }
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

        // Sync changes with the profiles table if userId exists
        if (userId) {
            const { error: profileError } = await supabaseAdmin
                .from('profiles')
                .upsert({
                    user_id: userId,
                    full_name: full_name || existingStaff.full_name,
                    email: email || existingStaff.email,
                    phone: phone || existingStaff.phone
                }, { onConflict: 'user_id' });

            if (profileError) {
                console.error("Error updating profile for staff:", profileError.message);
            }
        }

        res.json(staffData);

    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
};
