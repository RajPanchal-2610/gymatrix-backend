import { supabaseAdmin } from '../lib/supabase';

export interface SendMessageOptions {
  gymId: number;
  recipientPhone: string;
  recipientName?: string;
  eventType: 'welcome' | 'membership_expiring' | 'payment_reminder' | 'custom';
  templateName?: string;
  variables: string[];
}

export interface MetaConfig {
  is_enabled: boolean;
  phone_number_id: string;
  waba_id: string;
  access_token: string;
  webhook_verify_token: string;
  default_country_code: string;
  templates: {
    welcome: string;
    membership_expiring: string;
    payment_reminder: string;
  };
}

class MetaWhatsAppService {
  /**
   * Normalize a phone number to E.164 without '+' or spaces, ensuring default country code (91)
   */
  normalizePhoneNumber(phone: string, defaultCountryCode: string = '91'): string {
    if (!phone) return '';
    let cleaned = phone.replace(/[\s\-\(\)\+]/g, '');
    
    // Remove leading zeroes
    cleaned = cleaned.replace(/^0+/, '');

    // If 10 digits (standard Indian mobile), prepend country code
    if (cleaned.length === 10) {
      cleaned = `${defaultCountryCode}${cleaned}`;
    }
    return cleaned;
  }

  /**
   * Fetch Super Admin's Central Meta Configuration from system_settings
   */
  async getMetaConfig(): Promise<MetaConfig> {
    try {
      const { data, error } = await supabaseAdmin
        .from('system_settings')
        .select('value')
        .eq('key', 'meta_whatsapp')
        .maybeSingle();

      if (error || !data || !data.value) {
        return {
          is_enabled: true,
          phone_number_id: process.env.META_WA_PHONE_NUMBER_ID || '',
          waba_id: process.env.META_WA_WABA_ID || '',
          access_token: process.env.META_WA_ACCESS_TOKEN || '',
          webhook_verify_token: process.env.META_WA_WEBHOOK_VERIFY_TOKEN || 'gymatrix_meta_webhook_secret_2026',
          default_country_code: '91',
          templates: {
            welcome: 'gym_welcome_member',
            membership_expiring: 'gym_membership_expiry',
            payment_reminder: 'gym_payment_reminder'
          }
        };
      }

      return data.value as MetaConfig;
    } catch (err) {
      console.error('Error fetching Meta WhatsApp config:', err);
      return {
        is_enabled: true,
        phone_number_id: '',
        waba_id: '',
        access_token: '',
        webhook_verify_token: 'gymatrix_meta_webhook_secret_2026',
        default_country_code: '91',
        templates: {
          welcome: 'gym_welcome_member',
          membership_expiring: 'gym_membership_expiry',
          payment_reminder: 'gym_payment_reminder'
        }
      };
    }
  }

  /**
   * Save / Update Super Admin Meta WhatsApp Configuration
   */
  async saveMetaConfig(config: Partial<MetaConfig>): Promise<boolean> {
    try {
      const current = await this.getMetaConfig();
      const merged = { ...current, ...config };

      const { error } = await supabaseAdmin
        .from('system_settings')
        .upsert({
          key: 'meta_whatsapp',
          value: merged,
          updated_at: new Date().toISOString()
        });

      if (error) throw error;
      return true;
    } catch (err) {
      console.error('Error saving Meta WhatsApp config:', err);
      return false;
    }
  }

  /**
   * Get or initialize gym's WhatsApp wallet, resetting monthly quota if billing period rolled over
   */
  async getGymWallet(gymId: number) {
    try {
      let { data: wallet, error } = await supabaseAdmin
        .from('gym_whatsapp_wallets')
        .select('*')
        .eq('gym_id', gymId)
        .maybeSingle();

      if (!wallet) {
        // Fetch gym's active subscription plan quota
        const { data: gym } = await supabaseAdmin
          .from('gyms')
          .select('owner_id')
          .eq('id', gymId)
          .maybeSingle();

        let planQuota = 100;
        let isYearly = false;
        if (gym?.owner_id) {
          const { data: sub } = await supabaseAdmin
            .from('subscriptions')
            .select('plan_id, plan_price_id, plans(whatsapp_quota_monthly, whatsapp_quota_yearly), plan_prices(duration_unit)')
            .eq('user_id', gym.owner_id)
            .in('status', ['active', 'Active', 'trial', 'Trial'])
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();

          const subPlan = sub?.plans as any;
          const subPrice = sub?.plan_prices as any;
          isYearly = subPrice?.duration_unit === 'year';

          if (isYearly) {
            planQuota = subPlan?.whatsapp_quota_yearly || (subPlan?.whatsapp_quota_monthly ? subPlan.whatsapp_quota_monthly * 12 : 1200);
          } else if (subPlan?.whatsapp_quota_monthly) {
            planQuota = subPlan.whatsapp_quota_monthly;
          }
        }

        const resetDays = isYearly ? 365 : 30;
        const { data: newWallet, error: insertErr } = await supabaseAdmin
          .from('gym_whatsapp_wallets')
          .insert({
            gym_id: gymId,
            plan_monthly_quota: planQuota,
            plan_quota_used: 0,
            addon_credits_balance: 0,
            plan_quota_reset_date: new Date(Date.now() + resetDays * 24 * 60 * 60 * 1000).toISOString()
          })
          .select()
          .single();

        if (insertErr) {
          console.error(`Failed to initialize wallet for gym ${gymId}:`, insertErr);
        }
        return newWallet;
      }

      // Check if monthly quota reset is due
      if (wallet.plan_quota_reset_date && new Date(wallet.plan_quota_reset_date) < new Date()) {
        const nextReset = new Date();
        nextReset.setMonth(nextReset.getMonth() + 1);

        const { data: updatedWallet } = await supabaseAdmin
          .from('gym_whatsapp_wallets')
          .update({
            plan_quota_used: 0,
            plan_quota_reset_date: nextReset.toISOString(),
            updated_at: new Date().toISOString()
          })
          .eq('id', wallet.id)
          .select()
          .single();

        if (updatedWallet) {
          wallet = updatedWallet;
        }
      }

      return wallet;
    } catch (err) {
      console.error(`Error in getGymWallet for gym ${gymId}:`, err);
      return null;
    }
  }

  /**
   * Deduct 1 message credit from the gym's wallet
   */
  private async deductCredit(walletId: number, wallet: any) {
    try {
      const updates: any = {
        total_messages_sent: (wallet.total_messages_sent || 0) + 1,
        updated_at: new Date().toISOString()
      };

      if ((wallet.plan_quota_used || 0) < (wallet.plan_monthly_quota || 0)) {
        updates.plan_quota_used = (wallet.plan_quota_used || 0) + 1;
      } else {
        updates.addon_credits_balance = Math.max(0, (wallet.addon_credits_balance || 0) - 1);
      }

      await supabaseAdmin
        .from('gym_whatsapp_wallets')
        .update(updates)
        .eq('id', walletId);
    } catch (err) {
      console.error('Error deducting credit from wallet:', err);
    }
  }

  /**
   * Build wa.me direct mobile sending URL
   */
  generateDeeplinkUrl(phone: string, text: string, defaultCountryCode: string = '91'): string {
    const cleanPhone = this.normalizePhoneNumber(phone, defaultCountryCode);
    if (!cleanPhone) return '';
    return `https://wa.me/${cleanPhone}?text=${encodeURIComponent(text)}`;
  }

  /**
   * Send an automated template message via Meta WhatsApp Cloud API
   */
  async sendTemplateMessage(options: SendMessageOptions) {
    const { gymId, recipientPhone, recipientName, eventType, variables } = options;
    const config = await this.getMetaConfig();

    const normalizedPhone = this.normalizePhoneNumber(recipientPhone, config.default_country_code || '91');
    if (!normalizedPhone) {
      return { success: false, error: 'Invalid recipient phone number' };
    }

    // 1. Verify Gym Wallet & Quota
    const wallet = await this.getGymWallet(gymId);
    if (!wallet) {
      return { success: false, error: 'Gym WhatsApp wallet not found' };
    }

    if (!wallet.is_automated_enabled) {
      return { success: false, code: 'AUTOMATED_DISABLED', error: 'Automated WhatsApp messaging is paused for this gym' };
    }

    if (eventType === 'welcome' && wallet.send_welcome_message === false) {
      return { success: false, code: 'WELCOME_DISABLED', error: 'Welcome WhatsApp message is disabled in gym settings' };
    }

    if (eventType === 'membership_expiring' && wallet.send_expiry_alert === false) {
      return { success: false, code: 'EXPIRY_ALERT_DISABLED', error: 'Membership expiry WhatsApp alert is disabled in gym settings' };
    }

    if (eventType === 'payment_reminder' && wallet.send_payment_reminder === false) {
      return { success: false, code: 'PAYMENT_REMINDER_DISABLED', error: 'Payment reminder WhatsApp message is disabled in gym settings' };
    }

    const availablePlanCredits = Math.max(0, (wallet.plan_monthly_quota || 0) - (wallet.plan_quota_used || 0));
    const totalAvailable = availablePlanCredits + (wallet.addon_credits_balance || 0);

    if (totalAvailable <= 0) {
      console.warn(`[WhatsApp] Quota exhausted for gym ${gymId}. Available: 0`);
      return {
        success: false,
        code: 'QUOTA_EXHAUSTED',
        error: 'WhatsApp message quota exhausted. Please purchase a monthly or yearly top-up pack to continue automated sending.'
      };
    }

    // 2. Resolve Template Name
    const templateName = options.templateName || (config.templates as any)[eventType] || 'gym_welcome_member';

    // 3. Resolve Sender Credentials (BYO owner credentials vs Central Super Admin)
    const useOwnerApi = !!(wallet.custom_phone_number_id && wallet.custom_access_token);
    const phoneNumberId = useOwnerApi ? wallet.custom_phone_number_id : config.phone_number_id;
    const accessToken = useOwnerApi ? wallet.custom_access_token : config.access_token;
    const senderMode = useOwnerApi ? 'meta_cloud_api_owner' : 'meta_cloud_api_central';

    // If Meta credentials are not configured yet, log a sandbox notice and record the action
    if (!phoneNumberId || !accessToken) {
      console.warn(`⚠️ [WhatsApp Sandbox] Meta credentials not configured. Message simulated for ${normalizedPhone} (Template: ${templateName})`);

      // Deduct credit in sandbox so quota tracking is demonstrated
      await this.deductCredit(wallet.id, wallet);

      const simMessageId = `sim_wamid_${Date.now()}_${Math.random().toString(36).substring(7)}`;
      await supabaseAdmin.from('whatsapp_logs').insert({
        gym_id: gymId,
        recipient_phone: normalizedPhone,
        recipient_name: recipientName || null,
        event_type: eventType,
        template_name: templateName,
        meta_message_id: simMessageId,
        sender_mode: senderMode,
        status: 'sent',
        credits_deducted: 1,
        error_message: 'Simulated send: Meta Phone Number ID or Access Token not configured yet in Super Admin Settings'
      });

      return {
        success: true,
        simulated: true,
        messageId: simMessageId,
        message: 'Message processed (Sandbox mode: configure Meta credentials in Super Admin Settings for live delivery)'
      };
    }

    // 4. Construct Meta Cloud API Payload
    const bodyParameters = variables.map((val) => ({
      type: 'text',
      text: String(val || '')
    }));

    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: normalizedPhone,
      type: 'template',
      template: {
        name: templateName,
        language: { code: 'en' },
        components: [
          {
            type: 'body',
            parameters: bodyParameters
          }
        ]
      }
    };

    try {
      const response = await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      const resData = await response.json();

      if (!response.ok) {
        const errorMsg = resData?.error?.message || `Meta API HTTP error ${response.status}`;
        console.error(`❌ Meta WhatsApp API error for ${normalizedPhone}:`, resData);

        await supabaseAdmin.from('whatsapp_logs').insert({
          gym_id: gymId,
          recipient_phone: normalizedPhone,
          recipient_name: recipientName || null,
          event_type: eventType,
          template_name: templateName,
          sender_mode: senderMode,
          status: 'failed',
          credits_deducted: 0,
          error_message: errorMsg
        });

        return { success: false, error: errorMsg, details: resData };
      }

      const metaMessageId = resData?.messages?.[0]?.id || null;

      // Deduct credit upon successful dispatch
      await this.deductCredit(wallet.id, wallet);

      await supabaseAdmin.from('whatsapp_logs').insert({
        gym_id: gymId,
        recipient_phone: normalizedPhone,
        recipient_name: recipientName || null,
        event_type: eventType,
        template_name: templateName,
        meta_message_id: metaMessageId,
        sender_mode: senderMode,
        status: 'sent',
        credits_deducted: 1
      });

      console.log(`✅ [WhatsApp] Message sent via Meta to ${normalizedPhone} (ID: ${metaMessageId})`);
      return { success: true, messageId: metaMessageId };
    } catch (error: any) {
      console.error(`❌ Unexpected error sending WhatsApp message to ${normalizedPhone}:`, error);

      await supabaseAdmin.from('whatsapp_logs').insert({
        gym_id: gymId,
        recipient_phone: normalizedPhone,
        recipient_name: recipientName || null,
        event_type: eventType,
        template_name: templateName,
        sender_mode: senderMode,
        status: 'failed',
        credits_deducted: 0,
        error_message: error.message
      });

      return { success: false, error: error.message };
    }
  }

  /**
   * Helper: Welcome Message to New Member
   */
  async sendWelcomeMessage(params: {
    gymId: number;
    gymName: string;
    gymPhone?: string;
    memberName: string;
    memberPhone: string;
    planName: string;
    startDate: string;
    endDate: string;
  }) {
    const { gymId, gymName, gymPhone, memberName, memberPhone, planName, startDate, endDate } = params;

    // Template variables: {{1}}=gym_name, {{2}}=member_name, {{3}}=plan_name, {{4}}=start_date, {{5}}=end_date, {{6}}=gym_phone
    const variables = [
      gymName || 'Our Gym',
      memberName,
      planName || 'Membership',
      startDate,
      endDate,
      gymPhone || 'the front desk'
    ];

    return this.sendTemplateMessage({
      gymId,
      recipientPhone: memberPhone,
      recipientName: memberName,
      eventType: 'welcome',
      variables
    });
  }

  /**
   * Helper: Membership Expiry Alert
   */
  async sendMembershipExpiryAlert(params: {
    gymId: number;
    gymName: string;
    gymPhone?: string;
    memberName: string;
    memberPhone: string;
    planName: string;
    expiryDate: string;
  }) {
    const { gymId, gymName, gymPhone, memberName, memberPhone, planName, expiryDate } = params;

    // Template variables: {{1}}=member_name, {{2}}=gym_name, {{3}}=plan_name, {{4}}=expiry_date, {{5}}=gym_phone
    const variables = [
      memberName,
      gymName || 'Our Gym',
      planName || 'Membership',
      expiryDate,
      gymPhone || 'the front desk'
    ];

    return this.sendTemplateMessage({
      gymId,
      recipientPhone: memberPhone,
      recipientName: memberName,
      eventType: 'membership_expiring',
      variables
    });
  }

  /**
   * Helper: Overdue Payment Reminder
   */
  async sendPaymentReminder(params: {
    gymId: number;
    gymName: string;
    gymPhone?: string;
    memberName: string;
    memberPhone: string;
    planName: string;
    dueAmount: number | string;
    dueDate: string;
  }) {
    const { gymId, gymName, gymPhone, memberName, memberPhone, planName, dueAmount, dueDate } = params;

    // Template variables: {{1}}=member_name, {{2}}=gym_name, {{3}}=due_amount, {{4}}=plan_name, {{5}}=due_date, {{6}}=gym_phone
    const variables = [
      memberName,
      gymName || 'Our Gym',
      String(dueAmount),
      planName || 'Membership',
      dueDate,
      gymPhone || 'the front desk'
    ];

    return this.sendTemplateMessage({
      gymId,
      recipientPhone: memberPhone,
      recipientName: memberName,
      eventType: 'payment_reminder',
      variables
    });
  }
}

export const metaWhatsAppService = new MetaWhatsAppService();
