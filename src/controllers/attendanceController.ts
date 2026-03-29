import { Request, Response } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { AuthenticatedRequest } from '../middleware/authMiddleware';

// Webhook for ZKTeco devices (or generic sync tool)
export const handleWebhook = async (req: Request, res: Response): Promise<void> => {
    try {
        const gymId = parseInt(req.params.gymId, 10);
        const { device_user_id, punch_time, punch_type, device_id } = req.body;

        if (!gymId) {
             res.status(401).json({ error: 'Unauthorized Gym ID missing' });
             return;
        }

        if (!device_user_id || !punch_time) {
             res.status(400).json({ error: 'device_user_id and punch_time are required' });
             return;
        }

        // 1. Insert into gym_attendance_logs
        const { error: logError } = await supabaseAdmin
            .from('gym_attendance_logs')
            .insert({
                gym_id: gymId,
                device_user_id,
                punch_time,
                punch_type: punch_type || 'AUTO',
                device_id: device_id || null
            });

        if (logError) {
            console.error('Error inserting raw log:', logError);
            res.status(500).json({ error: 'Failed to save raw log' });
            return;
        }

        // 2. Find the mapped user (member or staff)
        const { data: mapping, error: mappingError } = await supabaseAdmin
            .from('gym_device_mappings')
            .select('*')
            .eq('gym_id', gymId)
            .eq('device_user_id', device_user_id)
            .single();

        if (mappingError || !mapping) {
            console.warn(`No user mapped for device_user_id: ${device_user_id} in gym: ${gymId}`);
            // Return success even if not mapped, so device knows we received it
            res.status(200).json({ message: 'Log received. User not mapped.' });
            return;
        }

        // 3. Update active daily attendance
        const attendanceDate = new Date(punch_time).toISOString().split('T')[0];
        const punchTimeOnly = new Date(punch_time).toISOString().split('T')[1].split('.')[0]; // HH:MM:SS format

        if (mapping.user_type === 'member' && mapping.member_id) {
            await updateMemberDailyAttendance(gymId, mapping.member_id, attendanceDate, punchTimeOnly);
        } else if (mapping.user_type === 'staff' && mapping.staff_id) {
            await updateStaffDailyAttendance(gymId, mapping.staff_id, attendanceDate, punchTimeOnly);
        }

        res.status(200).json({ message: 'Log processed successfully' });
    } catch (error: any) {
        console.error('Webhook error:', error);
        res.status(500).json({ error: 'Internal server error while processing webhook' });
    }
};

const updateMemberDailyAttendance = async (gymId: number, memberId: number, date: string, timeString: string) => {
    // Check if record exists for today
    const { data: existing } = await supabaseAdmin
        .from('gym_member_attendance')
        .select('*')
        .eq('gym_id', gymId)
        .eq('member_id', memberId)
        .eq('attendance_date', date)
        .single();

    if (!existing) {
        // First punch of the day -> Check in
        await supabaseAdmin.from('gym_member_attendance').insert({
            gym_id: gymId,
            member_id: memberId,
            attendance_date: date,
            check_in_time: timeString,
            status: 'Present'
        });
    } else {
        // Subsequent punch -> Check out (or update check out if already checked out)
        // Calculate duration if check_in_time exists
        const checkIn = new Date(`1970-01-01T${existing.check_in_time}Z`);
        const checkOut = new Date(`1970-01-01T${timeString}Z`);
        let durationStr = null;

        if (!isNaN(checkIn.getTime()) && !isNaN(checkOut.getTime())) {
            let diffMs = Math.abs(checkOut.getTime() - checkIn.getTime());
            let hours = Math.floor(diffMs / (1000 * 60 * 60));
            let minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
            durationStr = `${hours}h ${minutes}m`;
        }

        await supabaseAdmin
            .from('gym_member_attendance')
            .update({
                check_out_time: timeString,
                duration: durationStr
            })
            .eq('id', existing.id);
    }
};

const updateStaffDailyAttendance = async (gymId: number, staffId: number, date: string, timeString: string) => {
    const { data: existing } = await supabaseAdmin
        .from('gym_staff_attendance')
        .select('*')
        .eq('gym_id', gymId)
        .eq('staff_id', staffId)
        .eq('attendance_date', date)
        .single();

    if (!existing) {
        // First punch -> Check in
        await supabaseAdmin.from('gym_staff_attendance').insert({
            gym_id: gymId,
            staff_id: staffId,
            attendance_date: date,
            check_in_time: timeString,
            status: 'Present'
        });
    } else {
        // Check out
        const checkIn = new Date(`1970-01-01T${existing.check_in_time}Z`);
        const checkOut = new Date(`1970-01-01T${timeString}Z`);
        let durationStr = null;

        if (existing.check_in_time && !isNaN(checkIn.getTime()) && !isNaN(checkOut.getTime())) {
            let diffMs = Math.abs(checkOut.getTime() - checkIn.getTime());
            let hours = Math.floor(diffMs / (1000 * 60 * 60));
            let minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
            durationStr = `${hours}h ${minutes}m`;
        }

        await supabaseAdmin
            .from('gym_staff_attendance')
            .update({
                check_out_time: timeString,
                duration: durationStr
            })
            .eq('id', existing.id);
    }
};

// GET /api/attendance/members
// Allowed for admin, owner, staff (maybe restricted by permissions)
export const getMemberAttendance = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
        const gymId = req.gymId;
        const date = req.query.date as string;
        const startDate = req.query.startDate as string;
        const endDate = req.query.endDate as string;

        if (!gymId) {
             res.status(401).json({ error: 'Unauthorized' });
             return;
        }

        let query = supabaseAdmin
            .from('gym_member_attendance')
            .select(`
                *,
                member:gym_members(id, full_name, image_url)
            `)
            .eq('gym_id', gymId)
            .order('attendance_date', { ascending: false })
            .order('check_in_time', { ascending: false });

        if (startDate && endDate) {
            query = query.gte('attendance_date', startDate).lte('attendance_date', endDate);
        } else if (date) {
            query = query.eq('attendance_date', date);
        } else {
             // Default to today if nothing provided
             query = query.eq('attendance_date', new Date().toISOString().split('T')[0]);
        }

        const { data, error } = await query;

        if (error) throw error;
        res.status(200).json(data);
    } catch (error: any) {
        console.error('Error fetching member attendance:', error);
        res.status(500).json({ error: error.message });
    }
};

// GET /api/attendance/staff
export const getStaffAttendance = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
        const gymId = req.gymId;
        const date = req.query.date as string;
        const startDate = req.query.startDate as string;
        const endDate = req.query.endDate as string;
        const staffId = req.query.staffId as string;

        if (!gymId) {
             res.status(401).json({ error: 'Unauthorized' });
             return;
        }

        let query = supabaseAdmin
            .from('gym_staff_attendance')
            .select(`
                *,
                staff:gym_staff(id, full_name, email)
            `)
            .eq('gym_id', gymId)
            .order('attendance_date', { ascending: false })
            .order('check_in_time', { ascending: false });

        if (staffId) {
            query = query.eq('staff_id', staffId);
        }

        if (startDate && endDate) {
            query = query.gte('attendance_date', startDate).lte('attendance_date', endDate);
        } else if (date) {
            query = query.eq('attendance_date', date);
        } else if (!startDate && !endDate && !date && !staffId) {
             // Default to today if no date filters are provided and no staff filter
             // Wait, maybe we just don't default and just give all if staffId is provided without dates
             // Let's just default to today if NO filters are provided at all.
             // If only staffId is provided, we fetch all their history
             query = query.eq('attendance_date', new Date().toISOString().split('T')[0]);
        } else if (!startDate && !endDate && !date && staffId) {
             // No date filter needed, get all for staffId
        }

        const { data, error } = await query;

        if (error) throw error;
        res.status(200).json(data);
    } catch (error: any) {
        console.error('Error fetching staff attendance:', error);
        res.status(500).json({ error: error.message });
    }
};

// POST /api/attendance/manual-punch
export const manualPunch = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
        const gymId = req.gymId;
        const { user_type, user_id, punch_type, time } // user_type: 'member'|'staff', punch_type: 'IN'|'OUT', time: 'HH:MM:SS'
            = req.body;

        if (!gymId) {
             res.status(401).json({ error: 'Unauthorized' });
             return;
        }

        const date = new Date().toISOString().split('T')[0];
        const timeString = time || new Date().toISOString().split('T')[1].split('.')[0]; 

        if (user_type === 'member') {
            const { data: existing } = await supabaseAdmin
                .from('gym_member_attendance')
                .select('*')
                .eq('gym_id', gymId)
                .eq('member_id', user_id)
                .eq('attendance_date', date)
                .single();

            if (!existing && punch_type === 'IN') {
                 await supabaseAdmin.from('gym_member_attendance').insert({
                    gym_id: gymId, member_id: user_id, attendance_date: date, check_in_time: timeString, status: 'Present'
                });
            } else if (existing && (punch_type === 'OUT' || punch_type === 'IN')) {
                 await updateMemberDailyAttendance(gymId, user_id, date, timeString);
            }
        } else if (user_type === 'staff') {
             const { data: existing } = await supabaseAdmin
                .from('gym_staff_attendance')
                .select('*')
                .eq('gym_id', gymId)
                .eq('staff_id', user_id)
                .eq('attendance_date', date)
                .single();

            if (!existing && punch_type === 'IN') {
                 await supabaseAdmin.from('gym_staff_attendance').insert({
                    gym_id: gymId, staff_id: user_id, attendance_date: date, check_in_time: timeString, status: 'Present'
                });
            } else if (existing && (punch_type === 'OUT' || punch_type === 'IN')) {
                 await updateStaffDailyAttendance(gymId, user_id, date, timeString);
            }
        }
        
        res.status(200).json({ message: 'Manual punch successful' });
    } catch (error: any) {
        console.error('Manual punch error:', error);
        res.status(500).json({ error: error.message });
    }
};

// GET /api/attendance/mapping/:userType/:userId
export const getMapping = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
        const gymId = req.gymId;
        const { userType, userId } = req.params;

        if (!gymId) { res.status(401).json({ error: 'Unauthorized' }); return; }

        const { data, error } = await supabaseAdmin
            .from('gym_device_mappings')
            .select('*')
            .eq('gym_id', gymId)
            .eq('user_type', userType)
            .eq(userType === 'member' ? 'member_id' : 'staff_id', userId)
            .maybeSingle();

        if (error) throw error;
        res.status(200).json(data || { device_user_id: '' });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
};

// POST /api/attendance/mapping
export const saveMapping = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
        const gymId = req.gymId;
        const { user_type, user_id, device_user_id } = req.body;

        if (!gymId) { res.status(401).json({ error: 'Unauthorized' }); return; }

        const matchField = user_type === 'member' ? 'member_id' : 'staff_id';

        // Check for existing
        const { data: existing, error: fetchErr } = await supabaseAdmin
            .from('gym_device_mappings')
            .select('id')
            .eq('gym_id', gymId)
            .eq('user_type', user_type)
            .eq(matchField, user_id)
            .maybeSingle();

        if (fetchErr) throw fetchErr;

        if (existing) {
            // Update
            if (device_user_id) {
                const { error } = await supabaseAdmin.from('gym_device_mappings').update({ device_user_id }).eq('id', existing.id);
                if (error) throw error;
            } else {
                // Delete if empty
                const { error } = await supabaseAdmin.from('gym_device_mappings').delete().eq('id', existing.id);
                if (error) throw error;
            }
        } else if (device_user_id) {
            // Insert
            const { error } = await supabaseAdmin.from('gym_device_mappings').insert({
                gym_id: gymId,
                device_user_id,
                user_type,
                [matchField]: user_id
            });
            if (error) throw error;
        }

        res.status(200).json({ message: 'Mapping saved successfully' });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
};
