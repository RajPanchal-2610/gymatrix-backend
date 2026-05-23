import { Request, Response, NextFunction } from 'express';
import { supabaseAdmin } from '../lib/supabase';

// Extend Express Request to include our custom injected data
export interface AuthenticatedRequest extends Request {
    user?: any;
    permissions?: string[];
    gymId?: number;
    staffId?: number;
    isSuperAdmin?: boolean;
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

        // 0. Check if user is Super Admin
        const { data: userRoles } = await supabaseAdmin
            .from('user_roles')
            .select('roles:roles(name)')
            .eq('user_id', user.id);

        const isSuperAdmin = userRoles?.some((ur: any) => ur.roles?.name === 'SUPER_ADMIN');

        if (isSuperAdmin) {
            req.permissions = ['*']; 
            req.isSuperAdmin = true;
            return next();
        }

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

export const requireFeature = (featureKey: string) => {
    return [
        authenticate,
        async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
            try {
                if (!req.gymId) {
                    return res.status(400).json({ error: 'Gym ID not found in request context' });
                }

                // 1. Get owner_id of the gym
                const { data: gym, error: gymError } = await supabaseAdmin
                    .from('gyms')
                    .select('owner_id')
                    .eq('id', req.gymId)
                    .maybeSingle();

                if (gymError || !gym) {
                    return res.status(404).json({ error: 'Gym or gym owner not found' });
                }

                const ownerId = gym.owner_id;

                // 2. Get active subscription for the owner
                const { data: sub, error: subError } = await supabaseAdmin
                    .from('subscriptions')
                    .select('id')
                    .eq('user_id', ownerId)
                    .eq('status', 'active')
                    .order('created_at', { ascending: false })
                    .limit(1)
                    .maybeSingle();

                if (subError || !sub) {
                    return res.status(403).json({ error: 'Access Denied: No active subscription found for this gym' });
                }

                // 3. Check if the active subscription has the specified feature enabled
                const { data: featureList, error: featureError } = await supabaseAdmin
                    .from('subscription_features')
                    .select('value, features!inner(key)')
                    .eq('subscription_id', sub.id)
                    .eq('features.key', featureKey)
                    .maybeSingle();

                if (featureError || !featureList || featureList.value !== 'true') {
                    return res.status(403).json({ error: `Access Denied: Feature '${featureKey}' is not enabled in your subscription plan` });
                }

                next();
            } catch (error) {
                console.error('Feature Check Middleware Error:', error);
                res.status(500).json({ error: 'Internal Server Error' });
            }
        }
    ];
};

export const requireSuperAdmin = [
    authenticate,
    (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        if (req.isSuperAdmin) {
            return next();
        }
        res.status(403).json({ error: 'Forbidden: Super Admin access required' });
    }
];


