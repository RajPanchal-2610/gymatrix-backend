import { Router } from 'express';
import { handleWebhook, getMemberAttendance, getStaffAttendance, manualPunch, getMapping, saveMapping } from '../controllers/attendanceController';
import { authenticate, requirePermission } from '../middleware/authMiddleware';

const router = Router();

// Used by external devices/systems. Still requires to identify the gym via API key or similar.
// Webhook for ZKTeco. Devices will send POST to /webhook/:gymId
// No authenticate middleware because devices don't have user tokens.
router.post('/webhook/:gymId', handleWebhook);

// Protected routes for dashboard
router.use(authenticate);

router.get('/members', getMemberAttendance);
router.get('/staff', getStaffAttendance);
router.post('/manual-punch', manualPunch);
router.get('/mapping/:userType/:userId', getMapping);
router.post('/mapping', saveMapping);

export default router;
