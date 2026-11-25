import webpush from 'web-push';
import { supabaseAdmin } from '../lib/supabase';

const vapidPublicKey = process.env.VAPID_PUBLIC_KEY;
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;
const vapidSubject = process.env.VAPID_SUBJECT || 'mailto:support@gymatrix.in';

let isConfigured = false;
if (vapidPublicKey && vapidPrivateKey) {
  try {
    webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
    isConfigured = true;
    console.log('🔔 Web Push service initialized with VAPID configuration');
  } catch (err) {
    console.error('❌ Failed to set VAPID details:', err);
  }
} else {
  console.warn('⚠️ Web Push VAPID keys not configured in backend environment');
}

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
  icon?: string;
  badge?: string;
}

export class WebPushService {
  /**
   * Save or update a user's browser push subscription
   */
  async saveSubscription(data: {
    userId: string;
    gymId?: number | null;
    endpoint: string;
    p256dh: string;
    auth: string;
    userAgent?: string;
  }) {
    const { userId, gymId, endpoint, p256dh, auth, userAgent } = data;

    const { data: saved, error } = await supabaseAdmin
      .from('push_subscriptions')
      .upsert(
        {
          user_id: userId,
          gym_id: gymId || null,
          endpoint,
          p256dh,
          auth,
          user_agent: userAgent || null,
          updated_at: new Date().toISOString()
        },
        { onConflict: 'endpoint' }
      )
      .select()
      .single();

    if (error) {
      console.error('Error saving push subscription:', error);
      throw error;
    }

    return saved;
  }

  /**
   * Remove a push subscription by endpoint
   */
  async removeSubscription(endpoint: string) {
    const { error } = await supabaseAdmin
      .from('push_subscriptions')
      .delete()
      .eq('endpoint', endpoint);

    if (error) {
      console.error('Error removing push subscription:', error);
      throw error;
    }

    return true;
  }

  /**
   * Send notification to a specific push subscription record
   */
  private async sendToSubscription(sub: any, payload: PushPayload): Promise<boolean> {
    if (!isConfigured) {
      console.warn('Web push not configured, skipping send');
      return false;
    }

    const pushConfig = {
      endpoint: sub.endpoint,
      keys: {
        p256dh: sub.p256dh,
        auth: sub.auth
      }
    };

    try {
      await webpush.sendNotification(pushConfig, JSON.stringify(payload));
      return true;
    } catch (err: any) {
      // 404 or 410 indicates subscription has expired or user revoked browser permission
      if (err.statusCode === 410 || err.statusCode === 404) {
        console.log(`Push subscription expired (${err.statusCode}). Cleaning up endpoint:`, sub.endpoint);
        await supabaseAdmin.from('push_subscriptions').delete().eq('id', sub.id);
      } else {
        console.error('Failed to dispatch web push notification:', err.message || err);
      }
      return false;
    }
  }

  /**
   * Send notification to all subscribers of a specific gym
   */
  async sendToGym(gymId: number, payload: PushPayload): Promise<{ sent: number; failed: number }> {
    try {
      const { data: subs, error } = await supabaseAdmin
        .from('push_subscriptions')
        .select('*')
        .eq('gym_id', gymId);

      if (error || !subs || subs.length === 0) {
        return { sent: 0, failed: 0 };
      }

      const results = await Promise.allSettled(
        subs.map(sub => this.sendToSubscription(sub, payload))
      );

      const sent = results.filter(r => r.status === 'fulfilled' && r.value === true).length;
      const failed = subs.length - sent;

      return { sent, failed };
    } catch (error) {
      console.error(`Error sending push notification to gym ${gymId}:`, error);
      return { sent: 0, failed: 0 };
    }
  }

  /**
   * Send notification to a specific user
   */
  async sendToUser(userId: string, payload: PushPayload): Promise<{ sent: number; failed: number }> {
    try {
      const { data: subs, error } = await supabaseAdmin
        .from('push_subscriptions')
        .select('*')
        .eq('user_id', userId);

      if (error || !subs || subs.length === 0) {
        return { sent: 0, failed: 0 };
      }

      const results = await Promise.allSettled(
        subs.map(sub => this.sendToSubscription(sub, payload))
      );

      const sent = results.filter(r => r.status === 'fulfilled' && r.value === true).length;
      const failed = subs.length - sent;

      return { sent, failed };
    } catch (error) {
      console.error(`Error sending push notification to user ${userId}:`, error);
      return { sent: 0, failed: 0 };
    }
  }

  /**
   * Check if web push service is active
   */
  getStatus() {
    return {
      configured: isConfigured,
      publicKey: vapidPublicKey ? `${vapidPublicKey.substring(0, 10)}...` : null
    };
  }
}

export const webPushService = new WebPushService();
