import express from 'express';
import { 
  createSubscriptionOrder, 
  verifySubscriptionPayment, 
  getSubscriptionHistory,
  createExtensionOrder,
  verifyExtensionPayment,
  getInvoiceDetails
} from '../controllers/paymentController';
import { getExtensionPrices, updateExtensionPrice, deleteExtensionPrice } from '../controllers/extensionController';

const router = express.Router();

router.post('/create-subscription-order', createSubscriptionOrder);
router.post('/verify-subscription-payment', verifySubscriptionPayment);
router.get('/history/:userId', getSubscriptionHistory);

// Extensions
router.get('/extensions/prices', getExtensionPrices);
router.put('/extensions/prices', updateExtensionPrice);
router.delete('/extensions/prices/:id', deleteExtensionPrice);
router.post('/extensions/create-order', createExtensionOrder);
router.post('/extensions/verify-payment', verifyExtensionPayment);
router.get('/invoice/:transactionId', getInvoiceDetails);

export default router;
