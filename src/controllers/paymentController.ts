import { Request, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import Razorpay from 'razorpay';
import crypto from 'crypto';

dotenv.config();

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID!,
  key_secret: process.env.RAZORPAY_KEY_SECRET!,
});

export const createSubscriptionOrder = async (req: Request, res: Response) => {
  try {
    const { userId, planPriceId, subscriptionId, extra_gyms = 0, extra_members = 0 } = req.body;

    if (!userId || !planPriceId || !subscriptionId) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    // 1. Fetch the actual plan price
    const { data: planPrice, error: priceError } = await supabaseAdmin
      .from('plan_prices')
      .select('price, duration_unit, duration_value')
      .eq('id', planPriceId)
      .single();

    if (priceError || !planPrice) {
      return res.status(404).json({ error: 'Plan price not found' });
    }

    // 2. Fetch extension prices to calculate the additional cost
    const { data: extPricing } = await supabaseAdmin
      .from('extension_pricing')
      .select('*');

    let extensionCharge = 0;
    if (extPricing) {
      const gymPrice = extPricing.find(p => p.type.toLowerCase().startsWith('gym'));
      const memberPrice = extPricing.find(p => p.type.toLowerCase().startsWith('member'));

      if (gymPrice && extra_gyms > 0) {
        extensionCharge += (extra_gyms / gymPrice.unit_quantity) * gymPrice.unit_price;
      }
      if (memberPrice && extra_members > 0) {
        extensionCharge += (extra_members / memberPrice.unit_quantity) * memberPrice.unit_price;
      }
    }

    // --- PRO-RATING LOGIC (CARRY-OVER BALANCE) ---
    let carriedCredit = 0;
    const { data: currentSub } = await supabaseAdmin
      .from('subscriptions')
      .select('amount, start_date, end_date, status')
      .eq('user_id', userId)
      .in('status', ['active', 'Active'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (currentSub && currentSub.amount > 0) {
      const now = new Date();
      const startDate = new Date(currentSub.start_date);
      const endDate = new Date(currentSub.end_date);
      
      if (endDate > now) {
        const msInDay = 24 * 60 * 60 * 1000;
        const totalDurationDays = Math.max(1, Math.ceil((endDate.getTime() - startDate.getTime()) / msInDay));
        const remainingDays = Math.max(0, Math.ceil((endDate.getTime() - now.getTime()) / msInDay));
        
        // Calculate raw credit based on remaining whole days
        carriedCredit = Math.floor((currentSub.amount / totalDurationDays) * remainingDays);
        console.log(`User ${userId} has ${remainingDays} days left. Credit: ₹${carriedCredit}`);
      }
    }

    // Final Amount to charge (Plan Price + Extensions - Carried Credit)
    // Minimum 1 rupee for Razorpay
    const baseTotal = planPrice.price + extensionCharge;
    const amountTotal = Math.max(1, baseTotal - carriedCredit);
    const amountInPaise = Math.round(amountTotal * 100);

    // 3. Generate generic receipt ID
    const receiptId = `RCPT-${crypto.randomUUID().split('-')[0]}`;

    // 4. Create Razorpay order
    const options = {
      amount: amountInPaise,
      currency: "INR",
      receipt: receiptId,
      notes: {
        userId,
        subscriptionId,
        planPriceId,
        extra_gyms: extra_gyms.toString(),
        extra_members: extra_members.toString(),
        carried_credit: carriedCredit.toString(),
        original_price: baseTotal.toString()
      }
    };

    const order = await razorpay.orders.create(options);

    // 5. Create pending transaction record
    const { data: transaction, error: txError } = await supabaseAdmin
      .from('subscription_transactions')
      .insert({
        user_id: userId,
        subscription_id: subscriptionId,
        plan_price_id: planPriceId,
        status: 'pending',
        receipt_id: receiptId,
        amount_total: amountTotal,
        amount_paid: amountTotal,
        razorpay_order_id: order.id,
        metadata: { extra_gyms, extra_members } // Store for verification
      })
      .select('id')
      .single();

    if (txError) {
      console.error("Error creating transaction record:", txError);
      return res.status(500).json({ error: 'Failed to record transaction start' });
    }

    res.json({
      orderId: order.id,
      currency: order.currency,
      amount: order.amount,
      transactionId: transaction.id,
      keyId: process.env.RAZORPAY_KEY_ID // send public key id to frontend
    });

  } catch (error: any) {
    console.error("Create order error:", error);
    res.status(500).json({ error: 'Failed to create subscription order' });
  }
};

export const verifySubscriptionPayment = async (req: Request, res: Response) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      transactionId,
      subscriptionId,
      planPriceId
    } = req.body;

    // 1. Verify the signature
    const bodyText = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET!)
      .update(bodyText.toString())
      .digest("hex");

    const isAuthentic = expectedSignature === razorpay_signature;

    if (!isAuthentic) {
      // Mark trans as failed
      await supabaseAdmin
        .from('subscription_transactions')
        .update({
          status: 'failed',
          error_code: 'signature_mismatch',
          error_description: 'Failed to verify payment signature'
        })
        .eq('id', transactionId);

      return res.status(400).json({ error: 'Invalid Payment Signature' });
    }

    // 1b. Fetch transaction metadata for extension quantities and total amount
    const { data: txData } = await supabaseAdmin
      .from('subscription_transactions')
      .select('metadata, amount_total')
      .eq('id', transactionId)
      .single();

    const meta = txData?.metadata as any || {};
    const finalExtraG = typeof meta.extra_gyms !== 'undefined' ? Number(meta.extra_gyms) : null;
    const finalExtraM = typeof meta.extra_members !== 'undefined' ? Number(meta.extra_members) : null;

    // 2. Fetch specific payment info to get fee, tax, and method
    const paymentInfo = await razorpay.payments.fetch(razorpay_payment_id);
    const feeInRupees = paymentInfo.fee ? Number(paymentInfo.fee) / 100 : null;
    const taxInRupees = paymentInfo.tax ? Number(paymentInfo.tax) / 100 : null;

    // Generate Invoice Number dynamically
    const invoiceNumber = `INV-${new Date().getFullYear()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

    // 4. Update the transaction to success
    const { error: txUpdateError } = await supabaseAdmin
      .from('subscription_transactions')
      .update({
        status: 'success',
        razorpay_payment_id,
        razorpay_signature,
        payment_method: paymentInfo.method || 'unknown',
        razorpay_fee: feeInRupees,
        razorpay_tax: taxInRupees,
        invoice_number: invoiceNumber
      })
      .eq('id', transactionId);

    if (txUpdateError) {
      console.error("Failed to update transaction status", txUpdateError);
    }

    // 5. Update actual Subscription Duration
    // Fetch the plan duration
    const { data: planPrice } = await supabaseAdmin
      .from('plan_prices')
      .select('duration_unit, duration_value, plan_id, price')
      .eq('id', planPriceId)
      .single();

    if (planPrice) {
      // Fetch the associated plan to get max_members and max_gyms
      const { data: plan } = await supabaseAdmin
        .from('plans')
        .select('max_members, max_gyms')
        .eq('id', planPrice.plan_id)
        .single();

      // We need to fetch the existing subscription to append time
      const { data: existingSub } = await supabaseAdmin
        .from('subscriptions')
        .select('*')
        .eq('id', subscriptionId)
        .single();

      if (existingSub && plan) {
        // Add logic to calculate new start and end dates
        const now = new Date();

        // Plan always starts from today and ends exactly at the end of the new duration
        let currentStart = now;
        let currentEnd = new Date(now);

        // Add new plan duration
        if (planPrice.duration_unit === 'month') {
          currentEnd.setMonth(currentEnd.getMonth() + planPrice.duration_value);
        } else if (planPrice.duration_unit === 'year') {
          currentEnd.setFullYear(currentEnd.getFullYear() + planPrice.duration_value);
        }

        // Use metadata amounts if available, otherwise fallback to existing (carryover default)
        const extraG = finalExtraG !== null ? finalExtraG : (existingSub.extra_gyms || 0);
        const extraM = finalExtraM !== null ? finalExtraM : (existingSub.extra_members || 0);

        // 1. Mark all existing/active subscriptions for this user as 'expired'
        await supabaseAdmin
          .from('subscriptions')
          .update({
            status: 'expired'
          })
          .eq('user_id', existingSub.user_id)
          .in('status', ['active', 'trial', 'Active', 'Trial']);

        // 2. Insert NEW Subscription record instead of updating
        const { data: newSub, error: subInsertError } = await supabaseAdmin
          .from('subscriptions')
          .insert({
            user_id: existingSub.user_id,
            status: 'active',
            end_date: currentEnd.toISOString(),
            start_date: currentStart.toISOString(),
            plan_id: planPrice.plan_id,
            plan_price_id: planPriceId,
            max_members: plan.max_members + extraM,
            max_gyms: plan.max_gyms + extraG,
            extra_members: extraM,
            extra_gyms: extraG,
            amount: txData?.amount_total || planPrice.price // Total paid (Plan + Extensions)
          })
          .select()
          .single();

        if (subInsertError || !newSub) {
          console.error("Failed to insert new subscription", subInsertError);
          throw new Error("Subscription activation failed");
        }

        // 3. Update transaction to point to the NEW subscription ID
        await supabaseAdmin
          .from('subscription_transactions')
          .update({
            subscription_id: newSub.id,
            status: 'success'
          })
          .eq('id', transactionId);

        // 4. Sync Features with the NEW subscription ID
        const { data: planFeatures } = await supabaseAdmin
          .from('plan_features')
          .select('feature_id, value')
          .eq('plan_id', planPrice.plan_id);

        if (planFeatures && planFeatures.length > 0) {
          // Insert new features for the new subscription
          const newFeatures = planFeatures.map(f => ({
            subscription_id: newSub.id,
            feature_id: f.feature_id,
            value: f.value
          }));
          await supabaseAdmin.from('subscription_features').insert(newFeatures);
        }
      }
    }

    res.json({ success: true, message: 'Payment verified and subscription activated.' });

  } catch (error: any) {
    console.error("Payment verification error:", error);
    res.status(500).json({ error: 'Internal server error during verification' });
  }
};

export const getSubscriptionHistory = async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;

    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    // 1. Fetch Plan Subscriptions
    const { data: subs, error: subsError } = await supabaseAdmin
      .from('subscriptions')
      .select(`
        *,
        plans(name),
        plan_prices(duration_unit, duration_value)
      `)
      .eq('user_id', userId);

    if (subsError) {
      console.error("Error fetching subs for history:", subsError);
      return res.status(500).json({ error: 'Failed to fetch subscriptions' });
    }

    // 2. Fetch Extension Add-ons for these subscriptions
    const subIds = subs?.map(s => s.id) || [];
    const { data: addons } = subIds.length > 0 ? await supabaseAdmin
      .from('subscription_addons')
      .select('*')
      .in('subscription_id', subIds) : { data: [] };

    // 3. Nest Add-ons into their parent Subscriptions
    const nestedHistory = (subs || []).map(s => {
      const subAddons = (addons || [])
        .filter(a => a.subscription_id === s.id)
        .map(a => ({
          id: a.id,
          isAddon: true,
          name: `Extra ${a.quantity} ${a.type}${a.quantity > 1 ? 's' : ''}`,
          amount: a.amount_paid,
          status: 'active',
          created_at: a.created_at,
          duration: s.plan_prices ? `${s.plan_prices.duration_value} ${s.plan_prices.duration_unit}(s)` : 'N/A', // Match Parent Duration
          quantity: a.quantity,
          type: a.type
        }))
        .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

      return {
        id: s.id,
        isAddon: false,
        name: s.plans?.name || 'Plan Update',
        amount: s.amount || 0,
        start_date: s.start_date,
        end_date: s.end_date,
        status: s.status,
        max_gyms: s.max_gyms,
        max_members: s.max_members,
        created_at: s.created_at,
        duration: s.plan_prices ? `${s.plan_prices.duration_value} ${s.plan_prices.duration_unit}(s)` : 'N/A',
        addons: subAddons
      };
    }).sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    res.json(nestedHistory);
  } catch (error: any) {
    console.error("Internal error in getSubscriptionHistory:", error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// --- EXTENSIONS ---

export const createExtensionOrder = async (req: Request, res: Response) => {
  try {
    const { userId, type, quantity, subscriptionId } = req.body;

    if (!userId || !type || !quantity || !subscriptionId) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    // 1. Fetch current price/unit for this extension type
    const { data: pricing, error: pricingError } = await supabaseAdmin
      .from('extension_pricing')
      .select('unit_price, unit_quantity')
      .eq('type', type)
      .single();

    if (pricingError || !pricing) {
      return res.status(404).json({ error: 'Extension pricing not found' });
    }

    // 2. Fetch subscription to calculate pro-rata based on time left
    const { data: sub, error: subError } = await supabaseAdmin
      .from('subscriptions')
      .select('end_date, start_date')
      .eq('id', subscriptionId)
      .single();

    if (subError || !sub) {
      return res.status(404).json({ error: 'Subscription not found' });
    }

    const now = new Date();
    const endDate = new Date(sub.end_date);
    const startDate = new Date(sub.start_date || sub.end_date); // fallback
    const diffMs = endDate.getTime() - now.getTime();

    if (diffMs <= 0) {
      return res.status(400).json({ error: 'Your subscription has expired. Please renew first.' });
    }

    // 3. Calculate Total (Pro-rata based on plan life remaining)
    // Formula: (Quantity / UnitQty) * UnitPrice * (RemainingTime / TotalPlanDuration)
    const dayInMs = 24 * 60 * 60 * 1000;
    const totalDays = Math.max(1, Math.ceil((endDate.getTime() - startDate.getTime()) / dayInMs));
    const daysPassed = Math.floor((now.getTime() - startDate.getTime()) / dayInMs);

    // Human-friendly pro-rating: 100% on Day 1, then drops daily.
    const durationRatio = Math.max(0, Math.min(1, (totalDays - daysPassed) / totalDays));

    const amountTotal = Math.max(1, Math.round(((quantity / pricing.unit_quantity) * pricing.unit_price) * durationRatio));
    const amountInPaise = Math.round(amountTotal * 100);

    // 3. Create Razorpay order
    const options = {
      amount: amountInPaise,
      currency: "INR",
      receipt: `EXT-${crypto.randomUUID().split('-')[0]}`,
      notes: {
        userId,
        subscriptionId,
        extensionType: type,
        quantity: quantity.toString()
      }
    };

    const order = await razorpay.orders.create(options);

    // 4. Create pending transaction (Reuse subscription_transactions for consistency)
    const { data: transaction, error: txError } = await supabaseAdmin
      .from('subscription_transactions')
      .insert({
        user_id: userId,
        subscription_id: subscriptionId,
        status: 'pending',
        receipt_id: options.receipt,
        amount_total: amountTotal,
        amount_paid: amountTotal,
        razorpay_order_id: order.id,
      })
      .select('id')
      .single();

    if (txError) {
      console.error("Error creating transaction record:", txError);
      return res.status(500).json({ error: 'Failed to record transaction start' });
    }

    res.json({
      orderId: order.id,
      currency: order.currency,
      amount: order.amount,
      transactionId: transaction.id,
      keyId: process.env.RAZORPAY_KEY_ID
    });

  } catch (error: any) {
    console.error("Create extension order error:", error);
    res.status(500).json({ error: 'Failed to create extension order' });
  }
};

export const verifyExtensionPayment = async (req: Request, res: Response) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      transactionId,
      subscriptionId,
      extensionType,
      quantity
    } = req.body;

    // 1. Signature check
    const bodyText = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET!)
      .update(bodyText.toString())
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      await supabaseAdmin
        .from('subscription_transactions')
        .update({ status: 'failed', error_code: 'signature_mismatch' })
        .eq('id', transactionId);
      return res.status(400).json({ error: 'Invalid Signature' });
    }

    // 2. Fetch payment info
    const paymentInfo = await razorpay.payments.fetch(razorpay_payment_id);
    const fee = paymentInfo.fee ? Number(paymentInfo.fee) / 100 : 0;
    const tax = paymentInfo.tax ? Number(paymentInfo.tax) / 100 : 0;

    // 3. Update Transaction
    await supabaseAdmin
      .from('subscription_transactions')
      .update({
        status: 'success',
        razorpay_payment_id,
        razorpay_signature,
        payment_method: paymentInfo.method || 'unknown',
        razorpay_fee: fee,
        razorpay_tax: tax,
        invoice_number: `INV-EXT-${new Date().getFullYear()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`
      })
      .eq('id', transactionId);

    // 4. Fetch the existing subscription
    const { data: sub } = await supabaseAdmin
      .from('subscriptions')
      .select('*')
      .eq('id', subscriptionId)
      .single();

    if (sub) {
      const typeLower = extensionType.toLowerCase();
      const isGym = typeLower.startsWith('gym');
      const isMember = typeLower.startsWith('member');

      console.log(`Verifying payment for ${extensionType}. Classified as - Gym: ${isGym}, Member: ${isMember}`);

      const extraG = isGym ? (sub.extra_gyms || 0) + Number(quantity) : (sub.extra_gyms || 0);
      const extraM = isMember ? (sub.extra_members || 0) + Number(quantity) : (sub.extra_members || 0);

      const maxG = isGym ? (sub.max_gyms || 0) + Number(quantity) : (sub.max_gyms || 0);
      const maxM = isMember ? (sub.max_members || 0) + Number(quantity) : (sub.max_members || 0);

      // 5. Update Subscription Limits
      const { error: updateError } = await supabaseAdmin
        .from('subscriptions')
        .update({
          extra_gyms: extraG,
          extra_members: extraM,
          max_gyms: maxG,
          max_members: maxM
        })
        .eq('id', subscriptionId);

      if (updateError) {
        console.error("Failed to update subscription limits after extension", updateError);
        throw new Error("Failed to activate extension limits in database");
      }

      // 6. Log in Audit Table
      await supabaseAdmin.from('subscription_addons').insert({
        subscription_id: subscriptionId,
        type: extensionType,
        quantity: Number(quantity),
        amount_paid: Number(paymentInfo.amount) / 100,
        transaction_id: transactionId
      });
    }

    res.json({ success: true, message: 'Extension activated successfully.' });

  } catch (error: any) {
    console.error("Extension verification error:", error);
    res.status(500).json({ error: 'Verification failed' });
  }
};
