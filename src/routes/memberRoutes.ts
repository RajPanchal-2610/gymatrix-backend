import express from 'express';
import {
  registerMember,
  loginMember,
  getMemberMe,
  getMemberDashboardData,
  changeMemberPassword,
} from '../controllers/memberAuthController';
import { authenticateMember } from '../middleware/memberAuthMiddleware';

const router = express.Router();

// Public auth endpoints
router.post('/register', registerMember);
router.post('/login', loginMember);

// Protected member portal endpoints
router.get('/me', authenticateMember, getMemberMe);
router.get('/dashboard', authenticateMember, getMemberDashboardData);
router.post('/change-password', authenticateMember, changeMemberPassword);

export default router;
