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
   * Start the cron job - runs hourly to check each gym's preferred notification hour
   */
  start() {
    // Cron pattern: minute hour day-of-month month day-of-week
    // '0 * * * *' means every hour at minute 0
    cron.schedule('0 * * * *', async () => {
      const currentHour = new Date().getHours();
      console.log(`⏰ Running hourly notification checkers for hour: ${currentHour}:00`);

      // Expiring subscriptions (global check) - run once daily at 7:00 AM
      if (currentHour === 7) {
        await this.checkExpiringSubscriptions();
      }

      await this.checkExpiringGymMemberships(currentHour);
      await this.checkOverdueGymPayments(currentHour);
    });

    console.log('✅ Subscription scheduler started - checks hourly for matching gym preferred times');
  }

  /**
   * Manually trigger the subscription check (for testing/admin)
   */
  async triggerManualCheck() {
    if (this.isRunning) {
      return { success: false, message: 'Scheduler is already running' };
    }
    await this.checkExpiringSubscriptions();
    await this.checkExpiringGymMemberships(null);
    await this.checkOverdueGymPayments(null);
    return { success: true, message: 'All notification checks completed' };
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
          
          // Insert in-app notification for the user
          try {
            await supabaseAdmin
              .from('notifications')
              .insert({
                user_id: subscription.user_id,
                title: isTrial ? 'Trial Expiring Soon' : 'Subscription Renewal Due',
                message: `Your Gymatrix ${planName} ${isTrial ? 'trial' : 'subscription'} will expire in 3 days on ${expiryDate}. Renew now to avoid interruption.`,
                type: 'system'
              });
            console.log(`✉️ In-app notification created for user ${subscription.user_id}`);
          } catch (notifError) {
            console.error('❌ Failed to insert in-app notification for subscription expiry:', notifError);
          }
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

  /**
   * Check for gym members whose active memberships match any configured notification day offset
   */
  async checkExpiringGymMemberships(currentHour?: number | null) {
    try {
      console.log(`🔍 Checking for gym member membership expiry notifications (hour: ${currentHour !== undefined && currentHour !== null ? `${currentHour}:00` : 'all'})...`);

      // 1. Fetch all gyms with their notification_settings
      const { data: gymsList, error: gymsError } = await supabaseAdmin
        .from('gyms')
        .select('id, notification_settings');

      if (gymsError) {
        console.error('❌ Error fetching gyms:', gymsError);
        return;
      }

      if (!gymsList || gymsList.length === 0) {
        console.log('✅ No gyms found');
        return;
      }

      const defaultSettings = {
        membership_expiry: { preferred_time: '07:00', before_days: [3], on_day: true, after_days: [] },
        overdue_payment: { preferred_time: '07:00', reminder_interval_days: 7, max_reminders: 0 }
      };

      for (const gym of gymsList) {
        const settings = gym.notification_settings || defaultSettings;
        const expiryConfig = settings.membership_expiry || defaultSettings.membership_expiry;

        if (currentHour !== undefined && currentHour !== null) {
          const preferredTimeStr = expiryConfig.preferred_time || '07:00';
          const preferredHour = parseInt(preferredTimeStr.split(':')[0]);
          if (preferredHour !== currentHour) {
            continue;
          }
        }

        // Collect all day offsets to check for this gym
        // before_days: positive offsets into the future (e.g., 3 = 3 days from now)
        // on_day: offset 0 (today)
        // after_days: negative offsets into the past (e.g., 3 = 3 days ago)
        const dayChecks: { offset: number; label: string }[] = [];

        if (expiryConfig.before_days && Array.isArray(expiryConfig.before_days)) {
          for (const d of expiryConfig.before_days) {
            dayChecks.push({ offset: d, label: `in ${d} day${d === 1 ? '' : 's'}` });
          }
        }

        if (expiryConfig.on_day) {
          dayChecks.push({ offset: 0, label: 'today' });
        }

        if (expiryConfig.after_days && Array.isArray(expiryConfig.after_days)) {
          for (const d of expiryConfig.after_days) {
            dayChecks.push({ offset: -d, label: `${d} day${d === 1 ? '' : 's'} ago` });
          }
        }

        if (dayChecks.length === 0) continue;

        for (const check of dayChecks) {
          const targetDate = new Date();
          targetDate.setDate(targetDate.getDate() + check.offset);

          const startOfDay = new Date(targetDate);
          startOfDay.setHours(0, 0, 0, 0);
          const endOfDay = new Date(targetDate);
          endOfDay.setHours(23, 59, 59, 999);

          // Query membership history for this gym matching this date
          const { data: histories, error: histError } = await supabaseAdmin
            .from('gym_membership_history')
            .select(`
              id,
              gym_id,
              member_id,
              plan_id,
              end_date,
              renewed_at,
              gym_members (
                full_name,
                trainer_id,
                gym_staff (
                  user_id
                )
              ),
              gym_membership_plans (
                name
              )
            `)
            .eq('gym_id', gym.id)
            .is('renewed_at', null)
            .gte('end_date', startOfDay.toISOString())
            .lte('end_date', endOfDay.toISOString());

          if (histError) {
            console.error(`❌ Error fetching memberships for gym ${gym.id}, offset ${check.offset}:`, histError);
            continue;
          }

          if (!histories || histories.length === 0) continue;

          // 7-day dedup window
          const sevenDaysAgo = new Date();
          sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

          for (const history of histories) {
            const member = history.gym_members as any;
            const plan = history.gym_membership_plans as any;
            const memberName = member?.full_name || 'A member';
            const planName = plan?.name || 'membership plan';

            const trainerUserId = member?.gym_staff?.user_id || null;
            const targetGymId = trainerUserId ? null : history.gym_id;
            const targetUserId = trainerUserId || null;

            // Check for duplicate with same offset label
            let dupQuery = supabaseAdmin
              .from('notifications')
              .select('id')
              .eq('type', 'membership_expiring')
              .like('message', `%${memberName}%`)
              .like('message', `%${check.offset === 0 ? 'expires today' : check.offset > 0 ? `expire in ${check.offset} day` : `expired ${Math.abs(check.offset)} day`}%`)
              .gte('created_at', sevenDaysAgo.toISOString());

            if (targetGymId) {
              dupQuery = dupQuery.eq('gym_id', targetGymId);
            } else {
              dupQuery = dupQuery.eq('user_id', targetUserId);
            }

            const { data: existing } = await dupQuery;

            if (existing && existing.length > 0) {
              console.log(`⏭️ Skipping ${memberName} (gym ${history.gym_id}, offset ${check.offset}) - already notified`);
              continue;
            }

            const expiryDate = new Date(history.end_date).toLocaleDateString('en-US', {
              year: 'numeric',
              month: 'long',
              day: 'numeric'
            });

            // Build message based on offset
            let message: string;
            let title: string;
            if (check.offset > 0) {
              message = `${memberName}'s membership '${planName}' will expire in ${check.offset} day${check.offset === 1 ? '' : 's'} on ${expiryDate}.`;
              title = 'Member Membership Expiring';
            } else if (check.offset === 0) {
              message = `${memberName}'s membership '${planName}' expires today (${expiryDate}).`;
              title = 'Member Membership Expires Today';
            } else {
              const daysAgo = Math.abs(check.offset);
              message = `${memberName}'s membership '${planName}' expired ${daysAgo} day${daysAgo === 1 ? '' : 's'} ago on ${expiryDate} and has not been renewed.`;
              title = 'Member Membership Expired';
            }

            const { error: insertError } = await supabaseAdmin
              .from('notifications')
              .insert({
                gym_id: targetGymId,
                user_id: targetUserId,
                title,
                message,
                type: 'membership_expiring'
              });

            if (insertError) {
              console.error(`❌ Failed to create expiring notification for ${memberName}:`, insertError);
            } else {
              console.log(`✉️ [Gym ${history.gym_id}] ${title}: ${memberName} (offset: ${check.offset}, targetUser: ${targetUserId})`);
            }
          }
        }
      }
    } catch (error) {
      console.error('❌ Unexpected error in checkExpiringGymMemberships:', error);
    }
  }

  /**
   * Check for gym members who have unpaid or partial membership payments in the past (overdue)
   * Uses per-gym reminder_interval_days and max_reminders settings
   */
  async checkOverdueGymPayments(currentHour?: number | null) {
    try {
      console.log(`🔍 Checking for overdue member payments (hour: ${currentHour !== undefined && currentHour !== null ? `${currentHour}:00` : 'all'})...`);

      const today = new Date();
      today.setHours(23, 59, 59, 999);

      // 1. Fetch all gyms with their notification_settings
      const { data: gymsList, error: gymsError } = await supabaseAdmin
        .from('gyms')
        .select('id, notification_settings');

      if (gymsError) {
        console.error('❌ Error fetching gyms for overdue check:', gymsError);
        return;
      }

      if (!gymsList || gymsList.length === 0) return;

      const defaultOverdue = { reminder_interval_days: 7, max_reminders: 0 };

      for (const gym of gymsList) {
        const settings = gym.notification_settings || {};
        const overdueConfig = settings.overdue_payment || defaultOverdue;

        if (currentHour !== undefined && currentHour !== null) {
          const preferredTimeStr = overdueConfig.preferred_time || '07:00';
          const preferredHour = parseInt(preferredTimeStr.split(':')[0]);
          if (preferredHour !== currentHour) {
            continue;
          }
        }

        const intervalDays = overdueConfig.reminder_interval_days || 7;
        const maxReminders = overdueConfig.max_reminders || 0;

        // Query unpaid or partial payments billed in the past for this gym
        const { data: payments, error: paymentError } = await supabaseAdmin
          .from('gym_membership_payments')
          .select(`
            id,
            gym_id,
            member_id,
            due_amount,
            payment_status,
            billing_date,
            remarks,
            gym_members (
              full_name,
              trainer_id,
              gym_staff (
                user_id
              )
            ),
            gym_membership_history (
              plan_id,
              gym_membership_plans (
                name
              )
            )
          `)
          .eq('gym_id', gym.id)
          .in('payment_status', ['unpaid', 'partial'])
          .gt('due_amount', 0)
          .lt('billing_date', today.toISOString().split('T')[0]);

        if (paymentError) {
          console.error(`❌ Error fetching overdue payments for gym ${gym.id}:`, paymentError);
          continue;
        }

        if (!payments || payments.length === 0) continue;

        // Calculate dedup window based on gym's interval setting
        // If interval is 0 (only once), use a very large lookback
        const dedupDays = intervalDays === 0 ? 36500 : intervalDays; // 100 years for "only once"
        const dedupDate = new Date();
        dedupDate.setDate(dedupDate.getDate() - dedupDays);

        for (const payment of payments) {
          const member = payment.gym_members as any;
          const historyObj = payment.gym_membership_history as any;
          const plan = historyObj?.gym_membership_plans as any;
          const memberName = member?.full_name || 'A member';
          const planName = plan?.name || 'membership plan';

          const isPtPayment = payment.remarks === 'Personal Training Fee';
          const trainerUserId = isPtPayment ? (member?.gym_staff?.user_id || null) : null;
          const targetGymId = trainerUserId ? null : payment.gym_id;
          const targetUserId = trainerUserId || null;

          // Check existing notifications for this member within the dedup window
          let dupQuery = supabaseAdmin
            .from('notifications')
            .select('id')
            .eq('type', 'overdue_payment')
            .like('message', `%${memberName}%`)
            .like('message', `%overdue%`)
            .gte('created_at', dedupDate.toISOString());

          if (targetGymId) {
            dupQuery = dupQuery.eq('gym_id', targetGymId);
          } else {
            dupQuery = dupQuery.eq('user_id', targetUserId);
          }

          const { data: existing, error: existingError } = await dupQuery;

          if (existingError) {
            console.error('❌ Error checking existing overdue notifications:', existingError);
            continue;
          }

          if (existing && existing.length > 0) {
            // If max_reminders is set and we've already reached the limit, skip
            if (maxReminders > 0) {
              // Count total overdue notifications ever sent for this member
              let countQuery = supabaseAdmin
                .from('notifications')
                .select('id')
                .eq('type', 'overdue_payment')
                .like('message', `%${memberName}%`)
                .like('message', `%overdue%`);

              if (targetGymId) {
                countQuery = countQuery.eq('gym_id', targetGymId);
              } else {
                countQuery = countQuery.eq('user_id', targetUserId);
              }

              const { data: allNotifs } = await countQuery;

              if (allNotifs && allNotifs.length >= maxReminders) {
                console.log(`⏭️ Skipping ${memberName} (gym ${payment.gym_id}) - max reminders (${maxReminders}) reached`);
                continue;
              }
            }

            // Within dedup window, skip
            console.log(`⏭️ Skipping ${memberName} (gym ${payment.gym_id}) - recently notified (interval: ${intervalDays}d)`);
            continue;
          }

          // Max reminders check for new notification outside dedup window
          if (maxReminders > 0) {
            let countQuery = supabaseAdmin
              .from('notifications')
              .select('id')
              .eq('type', 'overdue_payment')
              .like('message', `%${memberName}%`)
              .like('message', `%overdue%`);

            if (targetGymId) {
              countQuery = countQuery.eq('gym_id', targetGymId);
            } else {
              countQuery = countQuery.eq('user_id', targetUserId);
            }

            const { data: allNotifs } = await countQuery;

            if (allNotifs && allNotifs.length >= maxReminders) {
              console.log(`⏭️ Skipping ${memberName} (gym ${payment.gym_id}) - max reminders (${maxReminders}) reached`);
              continue;
            }
          }

          const billingDateStr = new Date(payment.billing_date).toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric'
          });

          const { error: insertError } = await supabaseAdmin
            .from('notifications')
            .insert({
              gym_id: targetGymId,
              user_id: targetUserId,
              title: isPtPayment ? 'PT Fee Overdue Alert' : 'Overdue Payment Alert',
              message: isPtPayment
                ? `${memberName} has an overdue Personal Training Fee of ₹${payment.due_amount}, billed on ${billingDateStr}.`
                : `${memberName} has an overdue payment of ₹${payment.due_amount} for '${planName}', billed on ${billingDateStr}.`,
              type: 'overdue_payment'
            });

          if (insertError) {
            console.error(`❌ Failed to create overdue notification for ${memberName}:`, insertError);
          } else {
            console.log(`✉️ [Gym ${gym.id}] Overdue payment notification: ${memberName} (₹${payment.due_amount})`);
          }
        }
      }
    } catch (error) {
      console.error('❌ Unexpected error in checkOverdueGymPayments:', error);
    }
  }
}


export const subscriptionScheduler = new SubscriptionScheduler();
