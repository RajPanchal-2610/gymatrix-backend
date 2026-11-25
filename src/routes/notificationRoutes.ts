import express from 'express';
import { subscriptionScheduler } from '../services/subscriptionScheduler';
import { emailService } from '../services/emailService';
import { webPushService } from '../services/webPushService';
import { authenticate, AuthenticatedRequest } from '../middleware/authMiddleware';

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

/**
 * GET /api/notifications/push/public-key
 * Retrieve VAPID Public Key for client subscription
 */
router.get('/push/public-key', (_req, res) => {
  res.json({
    publicKey: process.env.VAPID_PUBLIC_KEY || null
  });
});

/**
 * POST /api/notifications/push/subscribe
 * Register or update browser push subscription
 */
router.post('/push/subscribe', authenticate, async (req: AuthenticatedRequest, res) => {
  try {
    const { endpoint, keys, gymId } = req.body;
    const userId = req.user?.id;

    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return res.status(400).json({
        success: false,
        message: 'Invalid subscription object. endpoint, keys.p256dh, and keys.auth are required.'
      });
    }

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'User authentication required'
      });
    }

    const saved = await webPushService.saveSubscription({
      userId,
      gymId: gymId || req.gymId || null,
      endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
      userAgent: req.headers['user-agent']
    });

    res.json({
      success: true,
      message: 'Push subscription registered successfully',
      data: saved
    });
  } catch (error: any) {
    console.error('Error in /push/subscribe:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to save push subscription',
      error: error.message
    });
  }
});

/**
 * POST /api/notifications/push/unsubscribe
 * Remove browser push subscription
 */
router.post('/push/unsubscribe', async (req, res) => {
  try {
    const { endpoint } = req.body;
    if (!endpoint) {
      return res.status(400).json({
        success: false,
        message: 'Endpoint is required'
      });
    }

    await webPushService.removeSubscription(endpoint);

    res.json({
      success: true,
      message: 'Push subscription removed successfully'
    });
  } catch (error: any) {
    console.error('Error in /push/unsubscribe:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to remove push subscription',
      error: error.message
    });
  }
});

/**
 * POST /api/notifications/push/test
 * Send a test push notification to verify browser notification display
 */
router.post('/push/test', authenticate, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user?.id;
    const gymId = req.gymId || req.body.gymId;

    if (!userId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    const payload = {
      title: 'Gymatrix Test Notification 🚀',
      body: 'Web push notifications are working perfectly on Chrome!',
      url: '/notifications',
      tag: `test-notification-${Date.now()}`
    };

    let result;
    if (gymId) {
      result = await webPushService.sendToGym(gymId, payload);
      // Fallback: if gym-level targeting found 0 devices, send directly to user
      if (result.sent === 0) {
        const userResult = await webPushService.sendToUser(userId, payload);
        if (userResult.sent > 0) {
          result = userResult;
        }
      }
    } else {
      result = await webPushService.sendToUser(userId, payload);
    }

    res.json({
      success: true,
      message: `Test push sent (${result.sent} delivered, ${result.failed} failed)`,
      result
    });
  } catch (error: any) {
    console.error('Error in /push/test:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send test push notification',
      error: error.message
    });
  }
});

export default router;
