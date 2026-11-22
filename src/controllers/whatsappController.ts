import { Request, Response } from 'express';
import crypto from 'crypto';
import Razorpay from 'razorpay';
import { supabaseAdmin } from '../lib/supabase';
import { metaWhatsAppService } from '../services/metaWhatsAppService';
import { AuthenticatedRequest } from '../middleware/authMiddleware';
import { encryptToken, decryptToken } from '../lib/encryption';

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || '',
  key_secret: process.env.RAZORPAY_KEY_SECRET || ''
});

/**
 * GET /api/whatsapp/wallet/:gymId
 * Fetch gym's WhatsApp wallet and usage details
 */
export const getWallet = async (req: Request, res: Response) => {
  try {
    const gymId = parseInt(req.params.gymId);
    if (isNaN(gymId)) {
      return res.status(400).json({ error: 'Invalid gym ID' });
    }

    const wallet = await metaWhatsAppService.getGymWallet(gymId);
    if (!wallet) {
      return res.status(404).json({ error: 'Wallet not found' });
    }

    const { data: gymData } = await supabaseAdmin
      .from('gyms')
      .select('notification_settings')
      .eq('id', gymId)
      .maybeSingle();

    const expiryTime = gymData?.notification_settings?.membership_expiry?.preferred_time || '07:00';
    const paymentTime = gymData?.notification_settings?.overdue_payment?.preferred_time || '07:00';
    const graceDays = gymData?.notification_settings?.overdue_payment?.payment_due_grace_days !== undefined
      ? gymData.notification_settings.overdue_payment.payment_due_grace_days
      : (gymData?.notification_settings?.overdue_payment?.new_member_due_days !== undefined
          ? gymData.notification_settings.overdue_payment.new_member_due_days
          : 3);

    const whatsappSender = gymData?.notification_settings?.whatsapp_sender ||
      ((wallet.custom_phone_number_id && wallet.custom_access_token) ? 'custom' : 'central');

    const availablePlan = Math.max(0, (wallet.plan_monthly_quota || 0) - (wallet.plan_quota_used || 0));
    const availableTotal = availablePlan + (wallet.addon_credits_balance || 0);

    res.json({
      ...wallet,
      whatsapp_sender: whatsappSender,
      expiry_preferred_time: expiryTime,
      payment_preferred_time: paymentTime,
      payment_due_grace_days: graceDays,
      new_member_due_days: graceDays,
      available_plan_credits: availablePlan,
      available_total: availableTotal
    });
  } catch (error: any) {
    console.error('Error fetching wallet:', error);
    res.status(500).json({ error: 'Failed to fetch wallet', details: error.message });
  }
};

/**
 * PUT /api/whatsapp/settings/:gymId
 * Update gym owner's WhatsApp notification settings (welcome, expiry, payment due toggles)
 */
export const updateGymSettings = async (req: Request, res: Response) => {
  try {
    const gymId = parseInt(req.params.gymId);
    if (isNaN(gymId)) {
      return res.status(400).json({ error: 'Invalid gym ID' });
    }

    const {
      is_automated_enabled,
      send_welcome_message,
      send_expiry_alert,
      send_payment_reminder,
      expiry_reminder_days,
      expiry_followup_interval,
      payment_reminder_days,
      payment_followup_interval,
      custom_phone_number_id,
      custom_waba_id,
      custom_access_token,
      expiry_preferred_time,
      payment_preferred_time,
      payment_due_grace_days,
      new_member_due_days,
      whatsapp_sender
    } = req.body;

    const updates: any = { updated_at: new Date().toISOString() };
    if (is_automated_enabled !== undefined) updates.is_automated_enabled = is_automated_enabled;
    if (send_welcome_message !== undefined) updates.send_welcome_message = send_welcome_message;
    if (send_expiry_alert !== undefined) updates.send_expiry_alert = send_expiry_alert;
    if (send_payment_reminder !== undefined) updates.send_payment_reminder = send_payment_reminder;
    if (Array.isArray(expiry_reminder_days)) updates.expiry_reminder_days = expiry_reminder_days;
    if (expiry_followup_interval !== undefined) updates.expiry_followup_interval = parseInt(expiry_followup_interval);
    if (Array.isArray(payment_reminder_days)) updates.payment_reminder_days = payment_reminder_days;
    if (payment_followup_interval !== undefined) updates.payment_followup_interval = parseInt(payment_followup_interval);
    if (custom_phone_number_id !== undefined) updates.custom_phone_number_id = custom_phone_number_id.trim();
    if (custom_waba_id !== undefined) updates.custom_waba_id = custom_waba_id.trim();
    if (custom_access_token !== undefined) updates.custom_access_token = custom_access_token.trim();

    // Ensure wallet exists first
    await metaWhatsAppService.getGymWallet(gymId);

    const { data: updatedWallet, error } = await supabaseAdmin
      .from('gym_whatsapp_wallets')
      .update(updates)
      .eq('gym_id', gymId)
      .select()
      .single();

    if (error) throw error;

    // Update gym notification_settings preferred_time, grace days & sender choice if provided
    const graceVal = payment_due_grace_days !== undefined
      ? parseInt(payment_due_grace_days)
      : (new_member_due_days !== undefined ? parseInt(new_member_due_days) : undefined);

    if (expiry_preferred_time !== undefined || payment_preferred_time !== undefined || graceVal !== undefined || whatsapp_sender !== undefined) {
      const { data: gymData } = await supabaseAdmin
        .from('gyms')
        .select('notification_settings')
        .eq('id', gymId)
        .maybeSingle();

      const currentNotif = gymData?.notification_settings || {};
      const newNotif = {
        ...currentNotif,
        ...(whatsapp_sender !== undefined ? { whatsapp_sender } : {}),
        membership_expiry: {
          ...(currentNotif.membership_expiry || {}),
          ...(expiry_preferred_time ? { preferred_time: expiry_preferred_time } : {})
        },
        overdue_payment: {
          ...(currentNotif.overdue_payment || {}),
          ...(payment_preferred_time ? { preferred_time: payment_preferred_time } : {}),
          ...(graceVal !== undefined ? { payment_due_grace_days: graceVal, new_member_due_days: graceVal } : {})
        }
      };

      await supabaseAdmin
        .from('gyms')
        .update({ notification_settings: newNotif })
        .eq('id', gymId);
    }

    res.json({
      success: true,
      wallet: {
        ...updatedWallet,
        whatsapp_sender: whatsapp_sender || 'central'
      }
    });
  } catch (error: any) {
    console.error('Error updating gym WhatsApp settings:', error);
    res.status(500).json({ error: 'Failed to update WhatsApp settings', details: error.message });
  }
};

/**
 * GET /api/whatsapp/logs/:gymId
 * Fetch delivery logs for a specific gym
 */
export const getLogs = async (req: Request, res: Response) => {
  try {
    const gymId = parseInt(req.params.gymId);
    const limit = parseInt(req.query.limit as string) || 50;

    const { data: logs, error } = await supabaseAdmin
      .from('whatsapp_logs')
      .select('*')
      .eq('gym_id', gymId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw error;
    res.json(logs || []);
  } catch (error: any) {
    console.error('Error fetching WhatsApp logs:', error);
    res.status(500).json({ error: 'Failed to fetch logs', details: error.message });
  }
};

/**
 * GET /api/whatsapp/packs
 * Fetch all available Top-Up packs (Monthly and Yearly)
 */
export const getPacks = async (req: Request, res: Response) => {
  try {
    const durationUnit = req.query.duration_unit as string;
    const includeInactive = req.query.include_inactive === 'true';

    let query = supabaseAdmin
      .from('whatsapp_addon_packs')
      .select('*')
      .order('price', { ascending: true });

    if (!includeInactive) {
      query = query.eq('is_active', true);
    }

    if (durationUnit) {
      query = query.eq('duration_unit', durationUnit);
    }

    const { data: packs, error } = await query;
    if (error) throw error;

    res.json(packs || []);
  } catch (error: any) {
    console.error('Error fetching addon packs:', error);
    res.status(500).json({ error: 'Failed to fetch packs', details: error.message });
  }
};

/**
 * Super Admin: Create a new WhatsApp Addon Pack
 * POST /api/whatsapp/super-admin/packs
 */
export const createPack = async (req: Request, res: Response) => {
  try {
    const { name, message_count, price, duration_value, duration_unit, description, is_active } = req.body;

    if (!name || !message_count || price === undefined || !duration_unit) {
      return res.status(400).json({ error: 'Name, message_count, price, and duration_unit are required' });
    }

    const { data: pack, error } = await supabaseAdmin
      .from('whatsapp_addon_packs')
      .insert({
        name,
        message_count: parseInt(message_count),
        price: parseFloat(price),
        duration_value: duration_value ? parseInt(duration_value) : 1,
        duration_unit,
        description: description || null,
        is_active: is_active !== false
      })
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, pack });
  } catch (error: any) {
    console.error('Error creating addon pack:', error);
    res.status(500).json({ error: 'Failed to create pack', details: error.message });
  }
};

/**
 * Super Admin: Update an existing WhatsApp Addon Pack
 * PUT /api/whatsapp/super-admin/packs/:id
 */
export const updatePack = async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const { name, message_count, price, duration_value, duration_unit, description, is_active } = req.body;

    const updates: any = { updated_at: new Date().toISOString() };
    if (name !== undefined) updates.name = name;
    if (message_count !== undefined) updates.message_count = parseInt(message_count);
    if (price !== undefined) updates.price = parseFloat(price);
    if (duration_value !== undefined) updates.duration_value = parseInt(duration_value);
    if (duration_unit !== undefined) updates.duration_unit = duration_unit;
    if (description !== undefined) updates.description = description;
    if (is_active !== undefined) updates.is_active = is_active;

    const { data: pack, error } = await supabaseAdmin
      .from('whatsapp_addon_packs')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, pack });
  } catch (error: any) {
    console.error('Error updating addon pack:', error);
    res.status(500).json({ error: 'Failed to update pack', details: error.message });
  }
};

/**
 * Super Admin: Delete an existing WhatsApp Addon Pack
 * DELETE /api/whatsapp/super-admin/packs/:id
 */
export const deletePack = async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const { error } = await supabaseAdmin
      .from('whatsapp_addon_packs')
      .delete()
      .eq('id', id);

    if (error) throw error;
    res.json({ success: true, message: 'Pack deleted successfully' });
  } catch (error: any) {
    console.error('Error deleting addon pack:', error);
    res.status(500).json({ error: 'Failed to delete pack', details: error.message });
  }
};

/**
 * POST /api/whatsapp/packs/create-order
 * Create a Razorpay order to purchase extra WhatsApp messages
 */
export const createPackOrder = async (req: Request, res: Response) => {
  try {
    const { gymId, packId, userId } = req.body;

    if (!gymId || !packId) {
      return res.status(400).json({ error: 'gymId and packId are required' });
    }

    const { data: pack, error: packErr } = await supabaseAdmin
      .from('whatsapp_addon_packs')
      .select('*')
      .eq('id', packId)
      .eq('is_active', true)
      .single();

    if (packErr || !pack) {
      return res.status(404).json({ error: 'Pack not found or is currently inactive' });
    }

    const amountInPaise = Math.round(pack.price * 100);
    const receipt = `wa_rcpt_${gymId}_${Date.now()}`.substring(0, 40);

    const order = await razorpay.orders.create({
      amount: amountInPaise,
      currency: 'INR',
      receipt,
      notes: {
        gymId: String(gymId),
        packId: String(packId),
        packName: pack.name,
        messages: String(pack.message_count),
        durationUnit: pack.duration_unit,
        userId: userId || ''
      }
    });

    res.json({
      success: true,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: process.env.RAZORPAY_KEY_ID,
      pack
    });
  } catch (error: any) {
    console.error('Error creating WhatsApp pack order:', error);
    res.status(500).json({ error: 'Failed to create payment order', details: error.message });
  }
};

/**
 * POST /api/whatsapp/packs/verify-payment
 * Verify Razorpay payment and credit extra messages to the gym wallet
 */
export const verifyPackPayment = async (req: Request, res: Response) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, gymId, packId } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !gymId || !packId) {
      return res.status(400).json({ error: 'Missing required payment verification details' });
    }

    // 1. Verify Razorpay Signature
    const body = `${razorpay_order_id}|${razorpay_payment_id}`;
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || '')
      .update(body)
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ error: 'Invalid payment signature' });
    }

    // 2. Fetch pack details
    const { data: pack, error: packErr } = await supabaseAdmin
      .from('whatsapp_addon_packs')
      .select('*')
      .eq('id', packId)
      .single();

    if (packErr || !pack) {
      return res.status(404).json({ error: 'Pack not found' });
    }

    // 3. Calculate validity date (1 month or 1 year)
    const expiresAt = new Date();
    if (pack.duration_unit === 'year') {
      expiresAt.setFullYear(expiresAt.getFullYear() + (pack.duration_value || 1));
    } else {
      expiresAt.setMonth(expiresAt.getMonth() + (pack.duration_value || 1));
    }

    // 4. Record pack purchase
    const { data: purchase, error: purchaseErr } = await supabaseAdmin
      .from('gym_whatsapp_pack_purchases')
      .insert({
        gym_id: gymId,
        pack_id: pack.id,
        pack_name: pack.name,
        duration_unit: pack.duration_unit,
        messages_credited: pack.message_count,
        amount_paid: pack.price,
        razorpay_payment_id,
        razorpay_order_id,
        expires_at: expiresAt.toISOString(),
        status: 'active'
      })
      .select()
      .single();

    if (purchaseErr) throw purchaseErr;

    // 5. Increment addon credits in gym wallet
    const wallet = await metaWhatsAppService.getGymWallet(gymId);
    const newBalance = (wallet?.addon_credits_balance || 0) + pack.message_count;

    await supabaseAdmin
      .from('gym_whatsapp_wallets')
      .update({
        addon_credits_balance: newBalance,
        updated_at: new Date().toISOString()
      })
      .eq('gym_id', gymId);

    res.json({
      success: true,
      message: `Successfully credited ${pack.message_count.toLocaleString()} extra WhatsApp messages!`,
      creditedMessages: pack.message_count,
      newAddonBalance: newBalance,
      purchase
    });
  } catch (error: any) {
    console.error('Error verifying WhatsApp pack payment:', error);
    res.status(500).json({ error: 'Failed to verify payment', details: error.message });
  }
};

/**
 * POST /api/whatsapp/send
 * Send an automated or test template message
 */
export const sendMessage = async (req: Request, res: Response) => {
  try {
    const { gymId, recipientPhone, recipientName, eventType, variables, templateName, languageCode } = req.body;

    if (!gymId || !recipientPhone || !eventType || !variables) {
      return res.status(400).json({ error: 'gymId, recipientPhone, eventType, and variables are required' });
    }

    const result = await metaWhatsAppService.sendTemplateMessage({
      gymId: parseInt(gymId),
      recipientPhone,
      recipientName,
      eventType,
      variables,
      templateName,
      languageCode
    });

    if (!result.success) {
      return res.status(400).json(result);
    }

    res.json(result);
  } catch (error: any) {
    console.error('Error in sendMessage controller:', error);
    res.status(500).json({ error: 'Failed to send message', details: error.message });
  }
};

/**
 * POST /api/whatsapp/deeplink
 * Generate wa.me deeplink URL for owner to send directly from their mobile WhatsApp
 */
export const getDeeplink = (req: Request, res: Response) => {
  try {
    const { phone, text, countryCode } = req.body;
    if (!phone || !text) {
      return res.status(400).json({ error: 'phone and text are required' });
    }

    const url = metaWhatsAppService.generateDeeplinkUrl(phone, text, countryCode || '91');
    res.json({ success: true, url });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to generate deeplink', details: error.message });
  }
};

/**
 * Super Admin: Get Meta WhatsApp Gateway Credentials
 * GET /api/whatsapp/config
 */
export const getConfig = async (req: Request, res: Response) => {
  try {
    const config = await metaWhatsAppService.getMetaConfig();
    // Mask sensitive access token for display
    const maskedConfig = {
      ...config,
      access_token: config.access_token ? `••••••••${config.access_token.slice(-6)}` : ''
    };
    res.json(maskedConfig);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to get Meta config', details: error.message });
  }
};

/**
 * Super Admin: Save Meta WhatsApp Gateway Credentials
 * POST /api/whatsapp/config
 */
export const saveConfig = async (req: Request, res: Response) => {
  try {
    const { is_enabled, phone_number_id, waba_id, access_token, webhook_verify_token, default_country_code, templates } = req.body;

    const updates: any = {};
    if (is_enabled !== undefined) updates.is_enabled = is_enabled;
    if (phone_number_id !== undefined) updates.phone_number_id = phone_number_id;
    if (waba_id !== undefined) updates.waba_id = waba_id;
    if (access_token && !access_token.startsWith('••••')) updates.access_token = access_token;
    if (webhook_verify_token !== undefined) updates.webhook_verify_token = webhook_verify_token;
    if (default_country_code !== undefined) updates.default_country_code = default_country_code;
    if (templates !== undefined) updates.templates = templates;

    const success = await metaWhatsAppService.saveMetaConfig(updates);
    if (!success) {
      return res.status(500).json({ error: 'Failed to save configuration' });
    }

    res.json({ success: true, message: 'Meta WhatsApp configuration updated successfully' });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to save Meta config', details: error.message });
  }
};

/**
 * POST /api/whatsapp/test-credentials
 * Test/verify custom Meta WhatsApp Cloud API credentials and discover WABA ID
 */
export const testCredentials = async (req: Request, res: Response) => {
  try {
    const { phoneNumberId, accessToken } = req.body;
    if (!phoneNumberId || !accessToken) {
      return res.status(400).json({ success: false, error: 'Phone Number ID and Access Token are required.' });
    }

    const trimmedPhoneId = String(phoneNumberId).trim();
    const trimmedToken = String(accessToken).trim();

    // Query Meta Graph API for the phone number details and linked WABA
    const response = await fetch(
      `https://graph.facebook.com/v20.0/${trimmedPhoneId}?fields=verified_name,display_phone_number,quality_rating,code_verification_status,whatsapp_business_account`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${trimmedToken}`
        }
      }
    );

    const data = await response.json();
    if (!response.ok) {
      const errMsg = data?.error?.message || `Meta API verification failed with HTTP ${response.status}`;
      return res.status(400).json({ success: false, error: errMsg });
    }

    const wabaId = data?.whatsapp_business_account?.id || null;

    res.json({
      success: true,
      verified_name: data.verified_name || 'Verified WhatsApp Business',
      display_phone_number: data.display_phone_number || trimmedPhoneId,
      quality_rating: data.quality_rating || 'UNKNOWN',
      code_verification_status: data.code_verification_status || 'VERIFIED',
      waba_id: wabaId
    });
  } catch (error: any) {
    console.error('Error testing WhatsApp credentials:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to verify credentials with Meta' });
  }
};

/**
 * POST /api/whatsapp/setup-templates
 * Auto-create or sync required Gymatrix templates on custom WABA
 */
export const setupWabaTemplates = async (req: Request, res: Response) => {
  try {
    const { wabaId, accessToken, gymId } = req.body;
    let resolvedWabaId = wabaId;
    let resolvedToken = accessToken;

    if ((!resolvedWabaId || !resolvedToken) && gymId) {
      const { data: wallet } = await supabaseAdmin
        .from('gym_whatsapp_wallets')
        .select('custom_waba_id, custom_access_token')
        .eq('gym_id', gymId)
        .maybeSingle();

      resolvedWabaId = resolvedWabaId || wallet?.custom_waba_id;
      resolvedToken = resolvedToken || wallet?.custom_access_token;
    }

    if (!resolvedWabaId || !resolvedToken) {
      return res.status(400).json({
        success: false,
        error: 'WhatsApp Business Account ID (WABA ID) and Access Token are required to setup templates.'
      });
    }

    const result = await metaWhatsAppService.setupTemplatesOnWaba({
      wabaId: resolvedWabaId,
      accessToken: resolvedToken
    });

    res.json(result);
  } catch (error: any) {
    console.error('Error setting up WhatsApp templates:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to setup templates on Meta' });
  }
};

/**
 * GET /api/whatsapp/templates/:gymId
 * Query template status on custom WABA for a gym
 */
export const getWabaTemplates = async (req: Request, res: Response) => {
  try {
    const gymId = parseInt(req.params.gymId);
    if (isNaN(gymId)) {
      return res.status(400).json({ error: 'Invalid gym ID' });
    }

    const { data: wallet } = await supabaseAdmin
      .from('gym_whatsapp_wallets')
      .select('custom_waba_id, custom_access_token')
      .eq('gym_id', gymId)
      .maybeSingle();

    if (!wallet?.custom_waba_id || !wallet?.custom_access_token) {
      return res.json({ success: true, templates: [] });
    }

    const result = await metaWhatsAppService.getWabaTemplatesStatus({
      wabaId: wallet.custom_waba_id,
      accessToken: wallet.custom_access_token
    });

    res.json(result);
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * POST /api/whatsapp/embedded-signup/complete
 * Exchange Meta OAuth authorization code, inspect WABA & Phone details (detecting Coexistence),
 * auto-subscribe WABA to webhooks, encrypt token at rest, and store connection against authenticated gym.
 */
export const completeEmbeddedSignup = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const gymId = req.gymId;
    if (!gymId) {
      return res.status(400).json({ error: 'Authenticated gym context is required' });
    }

    const { code, waba_id, phone_number_id } = req.body;
    if (!code) {
      return res.status(400).json({ error: 'Authorization code is required' });
    }

    const appId = process.env.META_APP_ID;
    const appSecret = process.env.META_APP_SECRET;

    if (!appId || !appSecret) {
      return res.status(500).json({
        error: 'Meta App configuration missing on server (META_APP_ID or META_APP_SECRET not configured in .env)'
      });
    }

    // 1. Exchange authorization code with Meta Graph API OAuth endpoint
    // In Embedded Signup with Facebook Login for Business, redirect_uri is omitted
    const tokenUrl = `https://graph.facebook.com/v21.0/oauth/access_token?client_id=${encodeURIComponent(
      appId
    )}&client_secret=${encodeURIComponent(appSecret)}&code=${encodeURIComponent(code)}`;

    const tokenRes = await fetch(tokenUrl, { method: 'GET' });
    const tokenData: any = await tokenRes.json();

    if (!tokenRes.ok || !tokenData.access_token) {
      console.error('❌ Error exchanging code with Meta:', tokenData);
      const errMsg = tokenData?.error?.message || 'Failed to exchange authorization code with Meta';
      return res.status(400).json({ error: errMsg, details: tokenData });
    }

    const accessToken = tokenData.access_token;
    const expiresInSeconds = tokenData.expires_in || 60 * 24 * 60 * 60; // 60 days default
    const tokenExpiry = new Date(Date.now() + expiresInSeconds * 1000).toISOString();

    // 2. Resolve WABA ID: either from signup callback or via debug_token
    let resolvedWabaId = waba_id;
    if (!resolvedWabaId) {
      try {
        const debugRes = await fetch(
          `https://graph.facebook.com/debug_token?input_token=${accessToken}&access_token=${appId}|${appSecret}`
        );
        const debugData: any = await debugRes.json();
        const granularScopes = debugData?.data?.granular_scopes || [];
        const mgmtScope = granularScopes.find((s: any) => s.scope === 'whatsapp_business_management');
        if (mgmtScope?.target_ids?.length > 0) {
          resolvedWabaId = mgmtScope.target_ids[0];
        }
      } catch (debugErr) {
        console.warn('Could not inspect debug_token for WABA ID:', debugErr);
      }
    }

    if (!resolvedWabaId) {
      return res.status(400).json({
        error: 'Could not determine WhatsApp Business Account (WABA) ID from Meta session'
      });
    }

    // 3. Fetch WABA Details
    let businessName = '';
    try {
      const wabaRes = await fetch(
        `https://graph.facebook.com/v21.0/${resolvedWabaId}?fields=id,name,currency,timezone_id`,
        {
          headers: { Authorization: `Bearer ${accessToken}` }
        }
      );
      const wabaData: any = await wabaRes.json();
      if (wabaRes.ok && wabaData.name) {
        businessName = wabaData.name;
      }
    } catch (wabaErr) {
      console.warn('Error fetching WABA details:', wabaErr);
    }

    // 4. Fetch Phone Numbers registered under this WABA
    let selectedPhone: any = null;
    let resolvedPhoneNumberId = phone_number_id || '';
    let displayPhoneNumber = '';

    try {
      const phoneRes = await fetch(
        `https://graph.facebook.com/v21.0/${resolvedWabaId}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating,code_verification_status,platform_type,is_on_biz_app,status`,
        {
          headers: { Authorization: `Bearer ${accessToken}` }
        }
      );
      const phoneData: any = await phoneRes.json();
      const phoneNumbers: any[] = phoneData?.data || [];

      selectedPhone = phoneNumbers.find((p) => p.id === phone_number_id) || phoneNumbers[0];

      // If not in the list but phone_number_id was provided, query directly
      if (!selectedPhone && phone_number_id) {
        const singlePhoneRes = await fetch(
          `https://graph.facebook.com/v21.0/${phone_number_id}?fields=id,display_phone_number,verified_name,quality_rating,code_verification_status,platform_type,is_on_biz_app,status`,
          {
            headers: { Authorization: `Bearer ${accessToken}` }
          }
        );
        if (singlePhoneRes.ok) {
          selectedPhone = await singlePhoneRes.json();
        }
      }

      if (selectedPhone) {
        resolvedPhoneNumberId = selectedPhone.id || resolvedPhoneNumberId;
        displayPhoneNumber = selectedPhone.display_phone_number || '';
        if (selectedPhone.verified_name) {
          businessName = selectedPhone.verified_name;
        }
      }
    } catch (phoneErr) {
      console.warn('Error fetching phone numbers for WABA:', phoneErr);
    }

    // 5. Coexistence Identification:
    // Meta sets is_on_biz_app = true for WhatsApp Business App Coexistence numbers
    const isOnBizApp = Boolean(selectedPhone?.is_on_biz_app);
    const integrationType = isOnBizApp ? 'business_app_coexistence' : 'cloud_api';

    // 6. Complete onboarding asset subscription:
    // Subscribe WABA to Gymatrix app's webhooks (POST /{waba_id}/subscribed_apps)
    try {
      const subRes = await fetch(
        `https://graph.facebook.com/v21.0/${resolvedWabaId}/subscribed_apps`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );
      const subData: any = await subRes.json();
      if (!subRes.ok) {
        console.warn('⚠️ Webhook auto-subscription returned non-OK status:', subData);
      } else {
        console.log(`✅ Successfully subscribed WABA ${resolvedWabaId} to app webhooks`);
      }
    } catch (subErr) {
      console.warn('⚠️ Error subscribing WABA to webhooks:', subErr);
    }

    // 7. Encrypt access token at rest using AES-256-GCM
    const encryptedToken = encryptToken(accessToken);

    // 8. Upsert into gym_whatsapp_integrations
    const integrationRecord = {
      gym_id: gymId,
      waba_id: resolvedWabaId,
      phone_number_id: resolvedPhoneNumberId,
      display_phone_number: displayPhoneNumber,
      business_name: businessName || null,
      access_token: encryptedToken,
      token_expiry: tokenExpiry,
      connection_status: 'connected',
      integration_type: integrationType,
      coexistence_status: {
        is_on_biz_app: isOnBizApp,
        coexistence_eligible: isOnBizApp,
        platform_type: selectedPhone?.platform_type || 'CLOUD_API',
        quality_rating: selectedPhone?.quality_rating || 'UNKNOWN',
        code_verification_status: selectedPhone?.code_verification_status || 'VERIFIED',
        connected_at: new Date().toISOString()
      },
      raw_metadata: {
        phone_object: selectedPhone || null,
        token_type: tokenData.token_type || 'bearer'
      },
      updated_at: new Date().toISOString()
    };

    const { data: savedIntegration, error: saveErr } = await supabaseAdmin
      .from('gym_whatsapp_integrations')
      .upsert(integrationRecord, { onConflict: 'gym_id' })
      .select(
        'id, gym_id, waba_id, phone_number_id, display_phone_number, business_name, token_expiry, connection_status, integration_type, coexistence_status, created_at, updated_at'
      )
      .single();

    if (saveErr) {
      console.error('Database error saving WhatsApp integration:', saveErr);
      throw saveErr;
    }

    // Keep gym_whatsapp_wallets synced for backward compatibility
    await supabaseAdmin
      .from('gym_whatsapp_wallets')
      .update({
        custom_phone_number_id: resolvedPhoneNumberId,
        custom_waba_id: resolvedWabaId,
        custom_access_token: encryptedToken,
        updated_at: new Date().toISOString()
      })
      .eq('gym_id', gymId);

    res.json({
      success: true,
      message: isOnBizApp
        ? 'WhatsApp Business connected with Coexistence active!'
        : 'WhatsApp Cloud API connected successfully!',
      integration: savedIntegration
    });
  } catch (error: any) {
    console.error('Error completing WhatsApp embedded signup:', error);
    res.status(500).json({
      error: 'Failed to complete WhatsApp connection',
      details: error.message
    });
  }
};

/**
 * GET /api/whatsapp/status
 * Get connection status and details for the authenticated gym (without exposing tokens)
 */
export const getWhatsAppStatus = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const gymId = req.gymId;
    if (!gymId) {
      return res.status(400).json({ error: 'Authenticated gym context is required' });
    }

    const { data: integration, error } = await supabaseAdmin
      .from('gym_whatsapp_integrations')
      .select(
        'id, gym_id, waba_id, phone_number_id, display_phone_number, business_name, token_expiry, connection_status, integration_type, coexistence_status, created_at, updated_at'
      )
      .eq('gym_id', gymId)
      .maybeSingle();

    if (error) {
      console.error('Error fetching WhatsApp integration:', error);
    }

    const wallet = await metaWhatsAppService.getGymWallet(gymId);
    const isConnected = !!(integration && integration.connection_status === 'connected');

    res.json({
      is_connected: isConnected,
      integration: integration || null,
      wallet: wallet || null
    });
  } catch (error: any) {
    console.error('Error fetching WhatsApp status:', error);
    res.status(500).json({ error: 'Failed to fetch WhatsApp status', details: error.message });
  }
};

/**
 * POST /api/whatsapp/disconnect
 * Disconnect gym WhatsApp integration and unsubscribe WABA from app webhooks
 */
export const disconnectWhatsApp = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const gymId = req.gymId;
    if (!gymId) {
      return res.status(400).json({ error: 'Authenticated gym context is required' });
    }

    const { data: integration } = await supabaseAdmin
      .from('gym_whatsapp_integrations')
      .select('*')
      .eq('gym_id', gymId)
      .maybeSingle();

    if (!integration) {
      return res.json({ success: true, message: 'No active integration found' });
    }

    // Try unsubscribing from Meta Graph API
    if (integration.waba_id && integration.access_token) {
      try {
        const decryptedToken = decryptToken(integration.access_token);
        await fetch(`https://graph.facebook.com/v21.0/${integration.waba_id}/subscribed_apps`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${decryptedToken}` }
        });
      } catch (e) {
        console.warn('Could not cleanly unsubscribe WABA from Meta during disconnect:', e);
      }
    }

    // Mark as disconnected in database
    await supabaseAdmin
      .from('gym_whatsapp_integrations')
      .update({
        connection_status: 'disconnected',
        updated_at: new Date().toISOString()
      })
      .eq('gym_id', gymId);

    // Clear custom sender from wallet
    await supabaseAdmin
      .from('gym_whatsapp_wallets')
      .update({
        custom_phone_number_id: null,
        custom_waba_id: null,
        custom_access_token: null,
        updated_at: new Date().toISOString()
      })
      .eq('gym_id', gymId);

    res.json({
      success: true,
      message: 'WhatsApp disconnected successfully. Automated messages will now route via default gateway.'
    });
  } catch (error: any) {
    console.error('Error disconnecting WhatsApp:', error);
    res.status(500).json({ error: 'Failed to disconnect WhatsApp', details: error.message });
  }
};

/**
 * Webhook Verification (GET /api/whatsapp/webhook)
 */
export const verifyWebhook = async (req: Request, res: Response) => {
  try {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    const config = await metaWhatsAppService.getMetaConfig();
    const expectedToken =
      process.env.META_WA_WEBHOOK_VERIFY_TOKEN ||
      config.webhook_verify_token ||
      'gymatrix_meta_webhook_secret_2026';

    if (mode === 'subscribe' && token === expectedToken) {
      console.log('✅ Meta WhatsApp webhook verified successfully!');
      return res.status(200).send(challenge);
    }

    console.warn('❌ Webhook verification failed. Token mismatch.');
    return res.status(403).json({ error: 'Webhook token verification failed' });
  } catch (error) {
    res.status(500).end();
  }
};

/**
 * Handle incoming Meta WhatsApp Webhook events (POST /api/whatsapp/webhook)
 * Verifies x-hub-signature-256 and handles:
 * - messages & statuses
 * - smb_message_echoes (Coexistence: messages sent from owner's mobile app)
 * - smb_app_state_sync (Coexistence: contact sync from mobile app)
 * - history (Coexistence: chat history backfill during onboarding)
 * - account_update (WABA & Phone quality/ban updates)
 */
export const handleWebhook = async (req: Request, res: Response) => {
  try {
    // 1. Signature Verification
    const signature = req.headers['x-hub-signature-256'] as string;
    const appSecret = process.env.META_APP_SECRET;

    if (appSecret && signature) {
      const elements = signature.split('sha256=');
      const signatureHash = elements[1];
      const rawPayload = (req as any).rawBody || Buffer.from(JSON.stringify(req.body));
      const expectedHash = crypto
        .createHmac('sha256', appSecret)
        .update(rawPayload)
        .digest('hex');

      if (signatureHash !== expectedHash) {
        console.warn('❌ Meta webhook signature mismatch');
        return res.status(401).send('Signature verification failed');
      }
    }

    const body = req.body;

    if (body.object === 'whatsapp_business_account' && Array.isArray(body.entry)) {
      for (const entry of body.entry) {
        const wabaId = entry.id;
        const changes = entry.changes || [];

        for (const change of changes) {
          const field = change.field;
          const val = change.value;

          // A. Standard Messages & Status Updates
          if (field === 'messages') {
            const statuses = val?.statuses || [];
            for (const statusObj of statuses) {
              const metaMsgId = statusObj.id;
              const status = statusObj.status; // 'sent', 'delivered', 'read', 'failed'
              const recipientId = statusObj.recipient_id;

              if (metaMsgId && status) {
                await supabaseAdmin
                  .from('whatsapp_logs')
                  .update({
                    status,
                    ...(statusObj.errors ? { error_message: JSON.stringify(statusObj.errors) } : {})
                  })
                  .eq('meta_message_id', metaMsgId);
              }
            }

            const messages = val?.messages || [];
            for (const msg of messages) {
              const fromPhone = msg.from;
              const msgId = msg.id;
              const msgText = msg.text?.body || msg.type || 'Media message';
              const phoneNumberId = val?.metadata?.phone_number_id;

              // Find gym integration
              const integration = phoneNumberId
                ? await metaWhatsAppService.findIntegrationByPhoneNumber(phoneNumberId)
                : await metaWhatsAppService.findIntegrationByWaba(wabaId);

              if (integration) {
                await supabaseAdmin.from('whatsapp_logs').insert({
                  gym_id: integration.gym_id,
                  recipient_phone: fromPhone,
                  recipient_name: val?.contacts?.[0]?.profile?.name || null,
                  event_type: 'custom',
                  template_name: 'incoming_member_message',
                  meta_message_id: msgId,
                  sender_mode:
                    integration.integration_type === 'business_app_coexistence'
                      ? 'meta_coexistence'
                      : 'meta_cloud_api_gym',
                  status: 'received',
                  credits_deducted: 0,
                  error_message: msgText.substring(0, 500)
                });
              }
            }
          }

          // B. Coexistence: smb_message_echoes
          // Triggers when gym owner sends a message directly from the mobile WhatsApp Business App
          else if (field === 'smb_message_echoes') {
            const echoes = val?.message_echoes || val?.messages || [];
            const phoneNumberId = val?.metadata?.phone_number_id;
            const integration = phoneNumberId
              ? await metaWhatsAppService.findIntegrationByPhoneNumber(phoneNumberId)
              : await metaWhatsAppService.findIntegrationByWaba(wabaId);

            if (integration && Array.isArray(echoes)) {
              for (const echo of echoes) {
                const echoId = echo.id;
                const toPhone = echo.to;
                const echoText = echo.text?.body || echo.type || 'App echo';

                await supabaseAdmin.from('whatsapp_logs').insert({
                  gym_id: integration.gym_id,
                  recipient_phone: toPhone,
                  recipient_name: null,
                  event_type: 'custom',
                  template_name: 'coexistence_app_echo',
                  meta_message_id: echoId,
                  sender_mode: 'meta_coexistence_app',
                  status: 'sent',
                  credits_deducted: 0,
                  error_message: echoText.substring(0, 500)
                });
              }
            }
          }

          // C. Coexistence: smb_app_state_sync
          // Triggers when mobile WhatsApp Business App state/contacts sync
          else if (field === 'smb_app_state_sync') {
            const phoneNumberId = val?.metadata?.phone_number_id;
            const integration = phoneNumberId
              ? await metaWhatsAppService.findIntegrationByPhoneNumber(phoneNumberId)
              : await metaWhatsAppService.findIntegrationByWaba(wabaId);

            if (integration) {
              const currentStatus = integration.coexistence_status || {};
              await supabaseAdmin
                .from('gym_whatsapp_integrations')
                .update({
                  coexistence_status: {
                    ...currentStatus,
                    last_app_state_sync_at: new Date().toISOString(),
                    sync_data_summary: val?.state || 'synced'
                  },
                  updated_at: new Date().toISOString()
                })
                .eq('id', integration.id);
            }
          }

          // D. Coexistence: history sync
          // Triggers when chat history is imported from the mobile app during onboarding
          else if (field === 'history') {
            const phoneNumberId = val?.metadata?.phone_number_id;
            const integration = phoneNumberId
              ? await metaWhatsAppService.findIntegrationByPhoneNumber(phoneNumberId)
              : await metaWhatsAppService.findIntegrationByWaba(wabaId);

            if (integration) {
              const currentStatus = integration.coexistence_status || {};
              await supabaseAdmin
                .from('gym_whatsapp_integrations')
                .update({
                  coexistence_status: {
                    ...currentStatus,
                    history_sync_completed_at: new Date().toISOString(),
                    history_status: val?.status || 'completed'
                  },
                  updated_at: new Date().toISOString()
                })
                .eq('id', integration.id);
            }
          }

          // E. account_update: WABA or Phone Number quality / ban / tier update
          else if (field === 'account_update') {
            const integration = await metaWhatsAppService.findIntegrationByWaba(wabaId);
            if (integration) {
              const currentStatus = integration.coexistence_status || {};
              await supabaseAdmin
                .from('gym_whatsapp_integrations')
                .update({
                  coexistence_status: {
                    ...currentStatus,
                    last_account_update: val,
                    last_account_update_at: new Date().toISOString()
                  },
                  updated_at: new Date().toISOString()
                })
                .eq('id', integration.id);
            }
          }
        }
      }
    }

    res.status(200).send('EVENT_RECEIVED');
  } catch (error) {
    console.error('Error handling Meta webhook:', error);
    res.status(200).send('EVENT_RECEIVED'); // Always acknowledge 200 to Meta
  }
};
