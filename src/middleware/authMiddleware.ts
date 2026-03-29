import { Request, Response, NextFunction } from 'express';
import { supabaseAdmin } from '../lib/supabase';

// Extend Express Request to include our custom injected data
export interface AuthenticatedRequest extends Request {
    user?: any;
    permissions?: string[];
    gymId?: number;
    staffId?: number;
}

// Base Authentication Middleware (Injects user, gymId, and permissions)
export const authenticate = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Missing or invalid Authorization header' });
        }

        const token = authHeader.split(' ')[1];
        const { data: { user }, error: userError } = await supabaseAdmin.auth.getUser(token);

        if (userError || !user) {
            return res.status(401).json({ error: 'Invalid token or user not found' });
        }

        req.user = user;

        // 1. Check if user is a Gym Owner (Owner has all permissions)
        const { data: gymData } = await supabaseAdmin
            .from('gyms')
            .select('id')
            .eq('owner_id', user.id)
            .limit(1)
            .maybeSingle();

        if (gymData) {
            req.gymId = gymData.id;
            req.permissions = ['*']; 
            return next();
        }

        // 2. If not owner, check Staff Record
        const { data: staffData, error: staffError } = await supabaseAdmin
            .from('gym_staff')
            .select('id, gym_id, role_id')
            .eq('user_id', user.id)
            .eq('is_deleted', false)
            .eq('status', 'active')
            .eq('allow_login', true)
            .maybeSingle();

        if (staffError || !staffData) {
            return res.status(403).json({ error: 'Access Denied: Not an active staff member or owner' });
        }

        req.gymId = staffData.gym_id;
        req.staffId = staffData.id;

        if (!staffData.role_id) {
            req.permissions = [];
            return next();
        }

        // 3. Fetch Permissions for Staff Role
        const { data: rolePerms, error: permError } = await supabaseAdmin
            .from('gym_role_permissions')
            .select('permissions ( action )')
            .eq('role_id', staffData.role_id);

        if (permError || !rolePerms) {
            return res.status(403).json({ error: 'Error fetching permissions' });
        }

        req.permissions = rolePerms.map((rp: any) => rp.permissions?.action).filter(Boolean);
        next();
    } catch (error) {
        console.error('Auth Middleware Error:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
};

export const requirePermission = (requiredPermission: string) => {
    return [
        authenticate,
        (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
            const permissions = req.permissions || [];
            if (permissions.includes('*') || permissions.includes(requiredPermission)) {
                return next();
            }
            res.status(403).json({ error: `Forbidden: Missing required permission '${requiredPermission}'` });
        }
    ];
};
