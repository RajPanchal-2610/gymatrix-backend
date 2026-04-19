import cron from 'node-cron';
import { supabaseAdmin } from '../lib/supabase';
import { emailService } from './emailService';

interface SubscriptionWithUser {
  id: number;
  status: string;
  end_date: string;
  user_id: string;
  plan_id: number;
  notification_sent: Record<string, string>;
  user_email: string;
  user_name: string;
  plan_name: string;
}

interface NotificationResult {
  subscriptionId: number;
  userId: string;
  email: string;
  type: string;
  success: boolean;
  error?: string;
}

export class SubscriptionScheduler {
  private isRunning = false;

  constructor() {
    console.log('🕒 Subscription scheduler initialized');
  }

  /**
   * Start the cron job - runs daily at 9:00 AM
   */
  start() {
    // Cron pattern: minute hour day-of-month month day-of-week
    // '0 9 * * *' means every day at 9:00 AM
    cron.schedule('0 9 * * *', async () => {
      console.log('⏰ Running subscription expiry check...');
      await this.checkExpiringSubscriptions();
    });

    console.log('✅ Subscription scheduler started - runs daily at 9:00 AM');
  }

  /**
   * Manually trigger the subscription check (for testing/admin)
   */
  async triggerManualCheck() {
    if (this.isRunning) {
      return { success: false, message: 'Scheduler is already running' };
    }
    await this.checkExpiringSubscriptions();
    return { success: true, message: 'Subscription check completed' };
  }

  /**
   * Main logic to check and send notifications for expiring subscriptions
   */
  private async checkExpiringSubscriptions() {
    if (this.isRunning) {
      console.log('⚠️ Scheduler is already running, skipping...');
      return;
    }

    this.isRunning = true;

    try {
      console.log('🔍 Checking for subscriptions expiring in 3 days...');

      // Calculate the date range: exactly 3 days from now
      const threeDaysFromNow = new Date();
      threeDaysFromNow.setDate(threeDaysFromNow.getDate() + 3);

      // Set to start of day for consistent comparison
      threeDaysFromNow.setHours(0, 0, 0, 0);
      const endOfThreeDaysFromNow = new Date(threeDaysFromNow);
      endOfThreeDaysFromNow.setHours(23, 59, 59, 999);

      // Query subscriptions expiring in 3 days that haven't been notified
      const { data: subscriptions, error } = await supabaseAdmin
        .from('subscriptions')
        .select(`
          id,
          status,
          end_date,
          user_id,
          plan_id,
          notification_sent
        `)
        .gte('end_date', threeDaysFromNow.toISOString())
        .lte('end_date', endOfThreeDaysFromNow.toISOString())
        .in('status', ['active', 'trial']);

      if (error) {
        console.error('❌ Error fetching subscriptions:', error);
        this.isRunning = false;
        return;
      }

      if (!subscriptions || subscriptions.length === 0) {
        console.log('✅ No subscriptions expiring in 3 days');
        this.isRunning = false;
        return;
      }

      console.log(`📧 Found ${subscriptions.length} subscription(s) expiring in 3 days`);

      // Fetch user emails separately (auth.users can't be joined directly)
      const userIds = subscriptions.map((sub: any) => sub.user_id);
      const { data: users, error: usersError } = await supabaseAdmin.auth.admin.listUsers();

      if (usersError) {
        console.error('❌ Error fetching users:', usersError);
        this.isRunning = false;
        return;
      }

      // Create a map of user_id to user data for quick lookup
      const userMap = new Map();
      users?.users?.forEach((user) => {
        userMap.set(user.id, {
          email: user.email || '',
          name: user.user_metadata?.full_name || user.user_metadata?.name || ''
        });
      });

      // Fetch plan names separately (Supabase foreign key joins can be unreliable)
      const planIds = [...new Set(subscriptions.map((sub: any) => sub.plan_id))];
      const { data: plans, error: plansError } = await supabaseAdmin
        .from('plans')
        .select('id, name')
        .in('id', planIds);

      if (plansError) {
        console.error('❌ Error fetching plans:', plansError);
      }

      // Create a map of plan_id to plan name
      const planMap = new Map();
      plans?.forEach((plan) => {
        planMap.set(plan.id, plan.name);
      });

      const results: NotificationResult[] = [];

      for (const sub of subscriptions) {
        const subscription = sub as unknown as SubscriptionWithUser;

        // Get user data from the map
        const userData = userMap.get(subscription.user_id);
        if (!userData || !userData.email) {
          console.log(`⚠️ Skipping subscription ${subscription.id} - no user email found`);
          continue;
        }

        // Override with fetched user data
        subscription.user_email = userData.email;
        subscription.user_name = userData.name;

        // Check if notification was already sent for this subscription
        const notificationKey = 'reminder_3_days';
        if (subscription.notification_sent?.[notificationKey]) {
          console.log(`⏭️ Skipping subscription ${subscription.id} - notification already sent`);
          continue;
        }

        // Extract plan name from the planMap
        const planName = planMap.get(subscription.plan_id) || 'Unknown Plan';

        // Determine notification type based on subscription status
        const isTrial = subscription.status === 'trial';
        const notificationType = isTrial ? 'trial_expiry_reminder' : 'subscription_renewal_reminder';

        // Extract user name from metadata or use email
        const userName = subscription.user_name ||
          subscription.user_email?.split('@')[0] ||
          'Valued Customer';

        // Format expiry date for display
        const expiryDate = new Date(subscription.end_date).toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'long',
          day: 'numeric'
        });

        // Send email
        let emailSuccess = false;
        let errorMessage: string | undefined;

        try {
          if (isTrial) {
            emailSuccess = await emailService.sendTrialExpiryReminder(
              subscription.user_email,
              userName,
              planName,
              expiryDate
            );
          } else {
            emailSuccess = await emailService.sendSubscriptionRenewalReminder(
              subscription.user_email,
              userName,
              planName,
              expiryDate
            );
          }
        } catch (error: any) {
          errorMessage = error.message || 'Unknown error occurred';
        }

        // Log the notification attempt
        await this.logNotification({
          subscriptionId: subscription.id,
          userId: subscription.user_id,
          email: subscription.user_email,
          type: notificationType,
          success: emailSuccess,
          error: errorMessage
        });

        // Update notification_sent column if successful
        if (emailSuccess) {
          await this.markNotificationSent(subscription.id, notificationKey);
        }

        results.push({
          subscriptionId: subscription.id,
          userId: subscription.user_id,
          email: subscription.user_email,
          type: notificationType,
          success: emailSuccess,
          error: errorMessage
        });

        console.log(
          `${emailSuccess ? '✅' : '❌'} ${notificationType} for subscription ${subscription.id} (${subscription.user_email})`
        );
      }

      // Summary
      const successCount = results.filter(r => r.success).length;
      const failCount = results.filter(r => !r.success).length;
      console.log(`\n📊 Notification Summary:`);
      console.log(`   ✅ Success: ${successCount}`);
      console.log(`   ❌ Failed: ${failCount}`);
      console.log(`   📝 Total Processed: ${results.length}`);

    } catch (error) {
      console.error('❌ Unexpected error in subscription scheduler:', error);
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Log notification attempt in notification_logs table
   */
  private async logNotification(result: NotificationResult) {
    try {
      const { error } = await supabaseAdmin
        .from('notification_logs')
        .insert({
          user_id: result.userId,
          subscription_id: result.subscriptionId,
          notification_type: result.type,
          email_address: result.email,
          status: result.success ? 'sent' : 'failed',
          metadata: result.error ? { error: result.error } : {}
        });

      if (error) {
        console.error('❌ Error logging notification:', error);
      }
    } catch (error) {
      console.error('❌ Failed to log notification:', error);
    }
  }

  /**
   * Mark notification as sent in subscription record
   */
  private async markNotificationSent(subscriptionId: number, notificationKey: string) {
    try {
      const timestamp = new Date().toISOString();

      const { error } = await supabaseAdmin
        .from('subscriptions')
        .update({
          notification_sent: {
            [notificationKey]: timestamp
          }
        })
        .eq('id', subscriptionId);

      if (error) {
        console.error(`❌ Error updating notification_sent for subscription ${subscriptionId}:`, error);
      }
    } catch (error) {
      console.error('❌ Failed to mark notification as sent:', error);
    }
  }
}

export const subscriptionScheduler = new SubscriptionScheduler();
