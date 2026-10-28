import express from 'express';
import {
  getWallet,
  updateGymSettings,
  getLogs,
  getPacks,
  createPack,
  updatePack,
  deletePack,
  createPackOrder,
  verifyPackPayment,
  sendMessage,
  getDeeplink,
  getConfig,
  saveConfig,
  verifyWebhook,
  handleWebhook
} from '../controllers/whatsappController';

const router = express.Router();

// Wallet, Settings & Logs
router.get('/wallet/:gymId', getWallet);
router.put('/settings/:gymId', updateGymSettings);
router.get('/logs/:gymId', getLogs);

// Add-on Packs Store (Monthly & Yearly)
router.get('/packs', getPacks);
router.post('/packs/create-order', createPackOrder);
router.post('/packs/verify-payment', verifyPackPayment);

// Super Admin Pack Management
router.post('/super-admin/packs', createPack);
router.put('/super-admin/packs/:id', updatePack);
router.delete('/super-admin/packs/:id', deletePack);

// Sending Endpoints
router.post('/send', sendMessage);
router.post('/deeplink', getDeeplink);

// Super Admin Meta WhatsApp Configuration
router.get('/config', getConfig);
router.post('/config', saveConfig);

// Meta Cloud API Webhook
router.get('/webhook', verifyWebhook);
router.post('/webhook', handleWebhook);

export default router;
