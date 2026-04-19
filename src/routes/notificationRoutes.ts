import express from 'express';
import { subscriptionScheduler } from '../services/subscriptionScheduler';
import { emailService } from '../services/emailService';

const router = express.Router();

/**
 * POST /api/notifications/check-subscriptions
 * Manually trigger the subscription expiry check (for testing/admin)
 */
router.post('/check-subscriptions', async (req, res) => {
  try {
    const result = await subscriptionScheduler.triggerManualCheck();
    
    if (result.success) {
      res.json({ 
        success: true, 
        message: result.message 
      });
    } else {
      res.status(409).json({ 
        success: false, 
        message: result.message 
      });
    }
  } catch (error: any) {
    console.error('Error triggering subscription check:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to trigger subscription check',
      error: error.message 
    });
  }
});

/**
 * POST /api/notifications/test-email
 * Send a test email to verify email configuration
 */
router.post('/test-email', async (req, res) => {
  try {
    const { to, userName } = req.body;
    
    if (!to) {
      return res.status(400).json({ 
        success: false, 
        message: 'Email address (to) is required' 
      });
    }

    const name = userName || 'Test User';
    const planName = 'Professional Plan';
    const expiryDate = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });

    // Send test renewal email
    const success = await emailService.sendSubscriptionRenewalReminder(
      to,
      name,
      planName,
      expiryDate
    );

    if (success) {
      res.json({ 
        success: true, 
        message: `Test email sent successfully to ${to}` 
      });
    } else {
      res.status(500).json({ 
        success: false, 
        message: 'Failed to send test email. Check server logs for details.' 
      });
    }
  } catch (error: any) {
    console.error('Error sending test email:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to send test email',
      error: error.message 
    });
  }
});

/**
 * GET /api/notifications/verify-email-connection
 * Verify email server connection
 */
router.get('/verify-email-connection', async (req, res) => {
  try {
    const isConnected = await emailService.verifyConnection();
    
    res.json({ 
      success: isConnected,
      message: isConnected ? 'Email connection successful' : 'Email connection failed'
    });
  } catch (error: any) {
    console.error('Error verifying email connection:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to verify email connection',
      error: error.message 
    });
  }
});

export default router;
