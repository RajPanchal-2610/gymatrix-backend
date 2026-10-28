import { Request, Response } from 'express';
import crypto from 'crypto';
import Razorpay from 'razorpay';
import { supabaseAdmin } from '../lib/supabase';
import { metaWhatsAppService } from '../services/metaWhatsAppService';

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

    const availablePlan = Math.max(0, (wallet.plan_monthly_quota || 0) - (wallet.plan_quota_used || 0));
    const availableTotal = availablePlan + (wallet.addon_credits_balance || 0);

    res.json({
      ...wallet,
      expiry_preferred_time: expiryTime,
      payment_preferred_time: paymentTime,
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
      payment_preferred_time
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

    // Update gym notification_settings preferred_time if provided
    if (expiry_preferred_time !== undefined || payment_preferred_time !== undefined) {
      const { data: gymData } = await supabaseAdmin
        .from('gyms')
        .select('notification_settings')
        .eq('id', gymId)
        .maybeSingle();

      const currentNotif = gymData?.notification_settings || {};
      const newNotif = {
        ...currentNotif,
        membership_expiry: {
          ...(currentNotif.membership_expiry || {}),
          ...(expiry_preferred_time ? { preferred_time: expiry_preferred_time } : {})
        },
        overdue_payment: {
          ...(currentNotif.overdue_payment || {}),
          ...(payment_preferred_time ? { preferred_time: payment_preferred_time } : {})
        }
      };

      await supabaseAdmin
        .from('gyms')
        .update({ notification_settings: newNotif })
        .eq('id', gymId);
    }

    res.json({ success: true, wallet: updatedWallet });
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
    const { gymId, recipientPhone, recipientName, eventType, variables, templateName } = req.body;

    if (!gymId || !recipientPhone || !eventType || !variables) {
      return res.status(400).json({ error: 'gymId, recipientPhone, eventType, and variables are required' });
    }

    const result = await metaWhatsAppService.sendTemplateMessage({
      gymId: parseInt(gymId),
      recipientPhone,
      recipientName,
      eventType,
      variables,
      templateName
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
 * Webhook Verification (GET /api/whatsapp/webhook)
 */
export const verifyWebhook = async (req: Request, res: Response) => {
  try {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    const config = await metaWhatsAppService.getMetaConfig();

    if (mode === 'subscribe' && token === config.webhook_verify_token) {
      console.log('✅ Meta WhatsApp webhook verified successfully!');
      return res.status(200).send(challenge);
    }
    return res.status(403).json({ error: 'Webhook token verification failed' });
  } catch (error) {
    res.status(500).end();
  }
};

/**
 * Handle incoming Meta WhatsApp Webhook events (POST /api/whatsapp/webhook)
 */
export const handleWebhook = async (req: Request, res: Response) => {
  try {
    const body = req.body;

    if (body.object === 'whatsapp_business_account') {
      const entry = body.entry?.[0];
      const change = entry?.changes?.[0];
      const value = change?.value;
      const statuses = value?.statuses;

      if (statuses && statuses.length > 0) {
        for (const statusObj of statuses) {
          const metaMsgId = statusObj.id;
          const status = statusObj.status; // 'sent', 'delivered', 'read', 'failed'

          if (metaMsgId && status) {
            await supabaseAdmin
              .from('whatsapp_logs')
              .update({ status })
              .eq('meta_message_id', metaMsgId);
          }
        }
      }
    }
    res.status(200).send('EVENT_RECEIVED');
  } catch (error) {
    console.error('Error handling Meta webhook:', error);
    res.status(200).send('EVENT_RECEIVED'); // Always acknowledge to Meta
  }
};
