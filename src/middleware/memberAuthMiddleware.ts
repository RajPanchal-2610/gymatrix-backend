import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { supabaseAdmin } from '../lib/supabase';

const JWT_SECRET = process.env.JWT_SECRET || 'gymatrix_member_jwt_secret_2026_super_secure';

export interface AuthenticatedMemberRequest extends Request {
  member?: {
    id: number;
    gym_id: number;
    phone: string;
    full_name: string;
    role: string;
  };
}

export const authenticateMember = async (
  req: AuthenticatedMemberRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid Authorization header' });
    }

    const token = authHeader.split(' ')[1];
    let decoded: any;

    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (jwtErr: any) {
      return res.status(401).json({ error: 'Session expired or invalid token. Please log in again.' });
    }

    if (!decoded || decoded.role !== 'MEMBER' || !decoded.id) {
      return res.status(403).json({ error: 'Access denied: Valid member session required.' });
    }

    // Verify member exists in database and is not deleted
    const { data: member, error: memberErr } = await supabaseAdmin
      .from('gym_members')
      .select('id, gym_id, phone, full_name, is_deleted, status')
      .eq('id', decoded.id)
      .maybeSingle();

    if (memberErr || !member || member.is_deleted) {
      return res.status(401).json({ error: 'Member account no longer exists or is disabled.' });
    }

    req.member = {
      id: member.id,
      gym_id: member.gym_id,
      phone: member.phone,
      full_name: member.full_name,
      role: 'MEMBER',
    };

    next();
  } catch (error: any) {
    console.error('Member auth error:', error);
    res.status(500).json({ error: 'Authentication verification failed' });
  }
};
