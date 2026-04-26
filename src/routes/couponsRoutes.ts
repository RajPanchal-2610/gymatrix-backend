import { Router } from 'express';
import { 
  getCoupons, 
  createCoupon, 
  updateCoupon, 
  deleteCoupon,
  validateCoupon,
  getCouponUsage
} from '../controllers/couponsController';

const router = Router();

// Super Admin Endpoints
router.get('/', getCoupons);
router.get('/:id/usage', getCouponUsage);
router.post('/', createCoupon);
router.patch('/:id', updateCoupon);
router.delete('/:id', deleteCoupon);

// General/Checkout Endpoints
router.post('/validate', validateCoupon);

export default router;
