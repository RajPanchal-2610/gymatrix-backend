import { Router } from 'express';
import { submitContactMessage, getAllMessages } from '../controllers/contactController';

const router = Router();

// Public route for submitting contact messages
router.post('/submit', submitContactMessage);

// Admin route (placeholder for now, should be protected in a real app)
router.get('/all', getAllMessages);

export default router;
