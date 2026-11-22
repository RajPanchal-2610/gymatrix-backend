import { supabaseAdmin } from '../lib/supabase';
import { decryptToken } from '../lib/encryption';

export interface GymWhatsAppIntegration {
  id: number;
  gym_id: number;
  waba_id: string;
  phone_number_id: string;
  display_phone_number?: string;
  business_name?: string;
  access_token: string;
  token_expiry?: string;
  connection_status: 'connected' | 'disconnected' | 'expired' | 'error';
  integration_type: 'business_app_coexistence' | 'cloud_api';
  coexistence_status?: any;
  raw_metadata?: any;
  created_at: string;
  updated_at: string;
}

export interface SendMessageOptions {
  gymId: number;
  recipientPhone: string;
  recipientName?: string;
  eventType: 'welcome' | 'membership_expiring' | 'payment_reminder' | 'custom';
  templateName?: string;
  languageCode?: string;
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
            welcome: 'gym_member_welcome_v1',
            membership_expiring: 'gym_membership_expiry_v1',
            payment_reminder: 'gym_payment_reminder_v1'
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
          welcome: 'gym_member_welcome_v1',
          membership_expiring: 'gym_membership_expiry_v1',
          payment_reminder: 'gym_payment_reminder_v1'
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
   * Fetch active WhatsApp integration for a specific gym
   */
  async getGymIntegration(gymId: number): Promise<GymWhatsAppIntegration | null> {
    try {
      const { data, error } = await supabaseAdmin
        .from('gym_whatsapp_integrations')
        .select('*')
        .eq('gym_id', gymId)
        .maybeSingle();

      if (error || !data) {
        return null;
      }
      return data as GymWhatsAppIntegration;
    } catch (err) {
      console.error(`Error fetching WhatsApp integration for gym ${gymId}:`, err);
      return null;
    }
  }

  /**
   * Set up required Gymatrix templates on a gym's custom Meta WABA
   */
  async setupTemplatesOnWaba(params: {
    wabaId: string;
    accessToken: string;
  }): Promise<{
    success: boolean;
    templates: Array<{
      name: string;
      status: string;
      category?: string;
      language?: string;
      reason?: string;
    }>;
    error?: string;
  }> {
    const { wabaId, accessToken } = params;
    const cleanWabaId = wabaId.trim();
    const cleanToken = accessToken.trim();

    // 1. Fetch existing templates on this WABA
    const existingMap = new Map<string, any>();
    try {
      const getRes = await fetch(
        `https://graph.facebook.com/v20.0/${cleanWabaId}/message_templates?fields=name,status,category,language&limit=100`,
        {
          headers: { Authorization: `Bearer ${cleanToken}` }
        }
      );
      if (getRes.ok) {
        const getData = await getRes.json();
        if (Array.isArray(getData.data)) {
          for (const t of getData.data) {
            existingMap.set(t.name, t);
          }
        }
      }
    } catch (e) {
      console.warn('Could not list existing templates:', e);
    }

    const REQUIRED_TEMPLATES = [
      {
        name: 'gym_member_welcome_v1',
        category: 'UTILITY',
        language: 'en_US',
        components: [
          {
            type: 'BODY',
            text: "Hi {{1}}, welcome to {{2}}! Your {{3}} membership is active from {{4}} to {{5}}. To access your member portal on Gymatrix, please register with your mobile number, set your password, and log in to track your fitness journey. We're excited to have you with us!",
            example: {
              body_text: [
                ['Prem', 'Gymatrix Fitness', 'Monthly Plan', '2026-11-20', '2026-12-20']
              ]
            }
          }
        ]
      },
      {
        name: 'gym_membership_expiry_v1',
        category: 'UTILITY',
        language: 'en_US',
        components: [
          {
            type: 'BODY',
            text: 'Hello {{1}}, this is a reminder from {{2}}. Your {{3}} membership is set to expire on {{4}}. Renew today to keep your fitness journey going uninterrupted! Log in to your member portal on Gymatrix to renew and view your plan details.',
            example: {
              body_text: [
                ['Prem', 'Gymatrix Fitness', 'Monthly Plan', 'November 25, 2026']
              ]
            }
          }
        ]
      },
      {
        name: 'gym_payment_reminder_v1',
        category: 'UTILITY',
        language: 'en_US',
        components: [
          {
            type: 'BODY',
            text: 'Dear {{1}}, this is a payment reminder from {{2}}. You have a pending balance of \u20B9{{3}} for your {{4}} membership, due on {{5}}. Log in to your member portal on Gymatrix to scan the payment QR code and clear your dues. Thank you!',
            example: {
              body_text: [
                ['Prem', 'Gymatrix Fitness', '600', 'Monthly Plan', 'November 25, 2026']
              ]
            }
          }
        ]
      }
    ];

    const results: Array<{ name: string; status: string; category?: string; language?: string; reason?: string }> = [];

    for (const tpl of REQUIRED_TEMPLATES) {
      const existing = existingMap.get(tpl.name);
      if (existing) {
        results.push({
          name: tpl.name,
          status: existing.status || 'APPROVED',
          category: existing.category || 'UTILITY',
          language: existing.language || 'en_US'
        });
        continue;
      }

      // Create template on WABA
      try {
        const createRes = await fetch(
          `https://graph.facebook.com/v20.0/${cleanWabaId}/message_templates`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${cleanToken}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(tpl)
          }
        );

        const createData = await createRes.json();
        if (createRes.ok) {
          results.push({
            name: tpl.name,
            status: createData.status || 'APPROVED',
            category: tpl.category,
            language: tpl.language
          });
        } else {
          const msg = createData?.error?.message || 'Failed to create template';
          const isDup = msg.toLowerCase().includes('already exists');
          results.push({
            name: tpl.name,
            status: isDup ? 'APPROVED' : 'FAILED',
            category: tpl.category,
            language: tpl.language,
            reason: msg
          });
        }
      } catch (err: any) {
        results.push({
          name: tpl.name,
          status: 'FAILED',
          reason: err.message
        });
      }
    }

    const allOk = results.every((r) => r.status === 'APPROVED' || r.status === 'PENDING');
    return {
      success: allOk,
      templates: results
    };
  }

  /**
   * Get template statuses from Meta WABA
   */
  async getWabaTemplatesStatus(params: {
    wabaId: string;
    accessToken: string;
  }): Promise<{
    success: boolean;
    templates: Array<{
      name: string;
      status: string;
      category?: string;
      language?: string;
    }>;
  }> {
    const { wabaId, accessToken } = params;
    const cleanWabaId = wabaId.trim();
    const cleanToken = accessToken.trim();

    try {
      const res = await fetch(
        `https://graph.facebook.com/v20.0/${cleanWabaId}/message_templates?fields=name,status,category,language&limit=100`,
        {
          headers: { Authorization: `Bearer ${cleanToken}` }
        }
      );
      if (!res.ok) {
        return { success: false, templates: [] };
      }
      const data = await res.json();
      const REQUIRED_NAMES = ['gym_member_welcome_v1', 'gym_membership_expiry_v1', 'gym_payment_reminder_v1'];
      const map = new Map<string, any>();
      if (Array.isArray(data.data)) {
        for (const t of data.data) {
          map.set(t.name, t);
        }
      }

      const templates = REQUIRED_NAMES.map((name) => {
        const item = map.get(name);
        return {
          name,
          status: item?.status || 'NOT_FOUND',
          category: item?.category || 'UTILITY',
          language: item?.language || 'en_US'
        };
      });

      return { success: true, templates };
    } catch (e) {
      return { success: false, templates: [] };
    }
  }

  /**
   * Find gym integration by Meta Phone Number ID (used in webhooks)
   */
  async findIntegrationByPhoneNumber(phoneNumberId: string): Promise<GymWhatsAppIntegration | null> {
    try {
      const { data, error } = await supabaseAdmin
        .from('gym_whatsapp_integrations')
        .select('*')
        .eq('phone_number_id', phoneNumberId)
        .maybeSingle();

      if (error || !data) return null;
      return data as GymWhatsAppIntegration;
    } catch (err) {
      console.error(`Error finding integration for phone number ${phoneNumberId}:`, err);
      return null;
    }
  }

  /**
   * Find gym integration by Meta WABA ID (used in webhooks)
   */
  async findIntegrationByWaba(wabaId: string): Promise<GymWhatsAppIntegration | null> {
    try {
      const { data, error } = await supabaseAdmin
        .from('gym_whatsapp_integrations')
        .select('*')
        .eq('waba_id', wabaId)
        .maybeSingle();

      if (error || !data) return null;
      return data as GymWhatsAppIntegration;
    } catch (err) {
      console.error(`Error finding integration for WABA ${wabaId}:`, err);
      return null;
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
            is_automated_enabled: false,
            send_welcome_message: false,
            send_expiry_alert: false,
            send_payment_reminder: false,
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

    if (eventType === 'welcome' && !wallet.send_welcome_message) {
      return { success: false, code: 'WELCOME_DISABLED', error: 'Welcome WhatsApp message is disabled in gym settings' };
    }

    if (eventType === 'membership_expiring' && !wallet.send_expiry_alert) {
      return { success: false, code: 'EXPIRY_ALERT_DISABLED', error: 'Membership expiry WhatsApp alert is disabled in gym settings' };
    }

    if (eventType === 'payment_reminder' && !wallet.send_payment_reminder) {
      return { success: false, code: 'PAYMENT_REMINDER_DISABLED', error: 'Payment reminder WhatsApp message is disabled in gym settings' };
    }

    // Fetch gym's configured sender mode ('central' | 'custom')
    const { data: gymData } = await supabaseAdmin
      .from('gyms')
      .select('notification_settings')
      .eq('id', gymId)
      .maybeSingle();

    const chosenSender = gymData?.notification_settings?.whatsapp_sender ||
      ((wallet.custom_phone_number_id && wallet.custom_access_token) ? 'custom' : 'central');

    const isCustomSender = chosenSender === 'custom' && !!(wallet.custom_phone_number_id && wallet.custom_access_token);
    const availablePlanCredits = Math.max(0, (wallet.plan_monthly_quota || 0) - (wallet.plan_quota_used || 0));
    const totalAvailable = availablePlanCredits + (wallet.addon_credits_balance || 0);

    if (!isCustomSender && totalAvailable <= 0) {
      console.warn(`[WhatsApp] Quota exhausted for gym ${gymId}. Available: 0`);
      return {
        success: false,
        code: 'QUOTA_EXHAUSTED',
        error: 'WhatsApp message quota exhausted. Please purchase a monthly or yearly top-up pack to continue automated sending.'
      };
    }

    // 2. Resolve Template Name
    const templateName = options.templateName || (config.templates as any)[eventType] || 'gym_member_welcome_v1';

    // 3. Resolve Sender Credentials:
    // Mode 1 (custom): Gym Owner's Own WhatsApp Cloud API Credentials (custom_phone_number_id & custom_access_token)
    // Mode 2 (central): Centralized Gymatrix / Panchal Tech WhatsApp Gateway
    const gymIntegration = await this.getGymIntegration(gymId);
    let phoneNumberId = '';
    let accessToken = '';
    let senderMode = 'meta_cloud_api_central';

    if (isCustomSender) {
      phoneNumberId = wallet.custom_phone_number_id.trim();
      accessToken = wallet.custom_access_token.trim();
      senderMode = 'meta_cloud_api_owner';
    } else if (gymIntegration && gymIntegration.connection_status === 'connected') {
      phoneNumberId = gymIntegration.phone_number_id;
      accessToken = decryptToken(gymIntegration.access_token);
      senderMode =
        gymIntegration.integration_type === 'business_app_coexistence'
          ? 'meta_coexistence'
          : 'meta_cloud_api_gym';
    } else {
      phoneNumberId = config.phone_number_id;
      accessToken = config.access_token;
      senderMode = 'meta_cloud_api_central';
    }

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

    let activeLang = options.languageCode || 'en';
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: normalizedPhone,
      type: 'template',
      template: {
        name: templateName,
        language: { code: activeLang },
        components: [
          {
            type: 'body',
            parameters: bodyParameters
          }
        ]
      }
    };

    try {
      let response = await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      let resData = await response.json();

      // Automatic Fallback: If translation error (code 132001), auto-retry between 'en' and 'en_US'
      if (!response.ok && resData?.error?.code === 132001) {
        const fallbackLang = (activeLang === 'en' || activeLang === 'en_GB') ? 'en_US' : 'en';
        console.warn(`⚠️ [WhatsApp] Template translation not found for '${activeLang}'. Auto-retrying with '${fallbackLang}'...`);
        payload.template.language.code = fallbackLang;

        response = await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload)
        });

        resData = await response.json();
      }

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

      // Deduct credit upon successful dispatch (if sending from own account, credits_deducted is 0 and only total count is incremented)
      const isOwnerSender = senderMode === 'meta_cloud_api_owner';
      if (isOwnerSender) {
        await supabaseAdmin
          .from('gym_whatsapp_wallets')
          .update({
            total_messages_sent: (wallet.total_messages_sent || 0) + 1,
            updated_at: new Date().toISOString()
          })
          .eq('id', wallet.id);
      } else {
        await this.deductCredit(wallet.id, wallet);
      }

      await supabaseAdmin.from('whatsapp_logs').insert({
        gym_id: gymId,
        recipient_phone: normalizedPhone,
        recipient_name: recipientName || null,
        event_type: eventType,
        template_name: templateName,
        meta_message_id: metaMessageId,
        sender_mode: senderMode,
        status: 'sent',
        credits_deducted: isOwnerSender ? 0 : 1
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
   * Template: gym_member_welcome
   * "Hi {{1}}, welcome to {{2}}! Your {{3}} membership is active from {{4}} to {{5}}. To access your member portal on Gymatrix, please register with your mobile number, set your password, and log in to track your fitness journey. We’re excited to have you with us!"
   */
  async sendWelcomeMessage(params: {
    gymId: number;
    gymName: string;
    gymPhone?: string;
    memberName: string;
    memberPhone: string;
    planName: string;
    startDate: string;
    endDate?: string;
  }) {
    const { gymId, gymName, memberName, memberPhone, planName, startDate, endDate } = params;

    // Variables: {{1}}=memberName, {{2}}=gymName, {{3}}=planName, {{4}}=startDate, {{5}}=endDate
    const variables = [
      memberName,
      gymName || 'Our Gym',
      planName || 'Membership',
      startDate,
      endDate || 'N/A'
    ];

    return this.sendTemplateMessage({
      gymId,
      recipientPhone: memberPhone,
      recipientName: memberName,
      eventType: 'welcome',
      templateName: 'gym_member_welcome_v1',
      variables
    });
  }

  /**
   * Helper: Membership Expiry Alert
   * Template: gym_membership_expiry_v1
   * "Hello {{1}}, this is a reminder from {{2}}. Your {{3}} membership is set to expire on {{4}}. Renew today to keep your fitness journey going uninterrupted! Log in to your member portal on Gymatrix to renew and view your plan details."
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
    const { gymId, gymName, memberName, memberPhone, planName, expiryDate } = params;

    // Template variables: {{1}}=member_name, {{2}}=gym_name, {{3}}=plan_name, {{4}}=expiry_date
    const variables = [
      memberName,
      gymName || 'Our Gym',
      planName || 'Membership',
      expiryDate
    ];

    return this.sendTemplateMessage({
      gymId,
      recipientPhone: memberPhone,
      recipientName: memberName,
      eventType: 'membership_expiring',
      templateName: 'gym_membership_expiry_v1',
      variables
    });
  }

  /**
   * Helper: Overdue Payment Reminder
   * Template: gym_payment_reminder_v1
   * "Dear {{1}}, this is a payment reminder from {{2}}. You have a pending balance of ₹{{3}} for your {{4}} membership, due on {{5}}. Log in to your member portal on Gymatrix to scan the payment QR code and clear your dues. Thank you!"
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
    const { gymId, gymName, memberName, memberPhone, planName, dueAmount, dueDate } = params;

    // Template variables: {{1}}=member_name, {{2}}=gym_name, {{3}}=due_amount, {{4}}=plan_name, {{5}}=due_date
    const variables = [
      memberName,
      gymName || 'Our Gym',
      String(dueAmount),
      planName || 'Membership',
      dueDate
    ];

    return this.sendTemplateMessage({
      gymId,
      recipientPhone: memberPhone,
      recipientName: memberName,
      eventType: 'payment_reminder',
      templateName: 'gym_payment_reminder_v1',
      variables
    });
  }
}

export const metaWhatsAppService = new MetaWhatsAppService();
