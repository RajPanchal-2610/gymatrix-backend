import { Request, Response, NextFunction } from 'express';
import { supabaseAdmin } from '../lib/supabase';

// Extend Express Request to include our custom injected data
export interface AuthenticatedRequest extends Request {
    user?: any;
    permissions?: string[];
    gymId?: number;
}

export const requirePermission = (requiredPermission: string) => {
    return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        try {
            const authHeader = req.headers.authorization;
            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                return res.status(401).json({ error: 'Missing or invalid Authorization header' });
            }

            const token = authHeader.split(' ')[1];

            // Verify JWT against Supabase Auth
            const { data: { user }, error: userError } = await supabaseAdmin.auth.getUser(token);

            if (userError || !user) {
                return res.status(401).json({ error: 'Invalid token or user not found' });
            }

            req.user = user;

            // Fetch Staff Record & Role
            const { data: staffData, error: staffError } = await supabaseAdmin
                .from('gym_staff')
                .select('gym_id, role_id')
                .eq('user_id', user.id)
                .single();

            if (staffError || !staffData) {
                return res.status(403).json({ error: 'User is not a staff member' });
            }

            req.gymId = staffData.gym_id;

            if (!staffData.role_id) {
                return res.status(403).json({ error: 'User does not have a role assigned' });
            }

            // Fetch Permissions for this Role
            const { data: rolePerms, error: permError } = await supabaseAdmin
                .from('role_permissions')
                .select('permissions ( action )')
                .eq('role_id', staffData.role_id);

            if (permError || !rolePerms) {
                return res.status(403).json({ error: 'Error fetching permissions' });
            }

            // Extract the action strings
            const permissions = rolePerms.map((rp: any) => rp.permissions?.action).filter(Boolean);
            req.permissions = permissions;

            // Check if user has required permission
            if (!permissions.includes(requiredPermission)) {
                return res.status(403).json({ error: `Forbidden: Missing required permission '${requiredPermission}'` });
            }

            // Proceed to the route handler
            next();
        } catch (error) {
            console.error('Auth Middleware Error:', error);
            res.status(500).json({ error: 'Internal Server Error' });
        }
    };
};
