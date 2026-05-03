import { Router } from 'express';
import { authenticate } from '../middleware/authMiddleware';
import * as reportsController from '../controllers/reportsController';

const router = Router();

router.get('/collection', authenticate, reportsController.getCollectionReport);
router.get('/plan-revenue', authenticate, reportsController.getPlanRevenue);
router.get('/membership-lifecycle', authenticate, reportsController.getMembershipLifecycle);
router.get('/overview', authenticate, reportsController.getReportsOverview);

export default router;
