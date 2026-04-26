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

/**
 * Generates a sequential invoice number
 */
const getNextInvoiceNumber = async (prefix: string = 'INV') => {
  try {
    // 1. Get the last transaction that has an invoice number with this prefix
    const { data: lastTx } = await supabaseAdmin
      .from('subscription_transactions')
      .select('invoice_number')
      .ilike('invoice_number', `${prefix}-%`)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    let nextNumber = 1;
    const currentYear = new Date().getFullYear();

    if (lastTx && lastTx.invoice_number) {
      const parts = lastTx.invoice_number.split('-');
      // For INV-2024-00001: parts.length = 3, num is at index 2
      // For INV-EXT-2024-00001: parts.length = 4, num is at index 3
      const numStr = parts[parts.length - 1];
      const lastNum = parseInt(numStr);
      if (!isNaN(lastNum)) {
        nextNumber = lastNum + 1;
      }
    }

    return `${prefix}-${currentYear}-${nextNumber.toString().padStart(5, '0')}`;
  } catch (error) {
    console.error("Error generating invoice number:", error);
    // Fallback if sequence fails
    return `${prefix}-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;
  }
};

/**
 * Helper to activate a subscription after payment or free purchase
 */
const activateSubscriptionInDB = async (transactionId: string, planPriceId: number, subscriptionId: string) => {
  // 1. Fetch Transaction Data
  const { data: txData } = await supabaseAdmin
    .from('subscription_transactions')
    .select('*')
    .eq('id', transactionId)
    .single();

  const meta = txData?.metadata as any || {};
  const finalExtraG = typeof meta.extra_gyms !== 'undefined' ? Number(meta.extra_gyms) : null;
  const finalExtraM = typeof meta.extra_members !== 'undefined' ? Number(meta.extra_members) : null;

  // Record Coupon Usage
  if (txData?.applied_coupon_id) {
    await supabaseAdmin.from('coupon_usage').insert({
      coupon_id: txData.applied_coupon_id,
      user_id: txData.user_id,
      transaction_id: transactionId
    });
  }

  // 2. Fetch the plan duration
  const { data: planPrice } = await supabaseAdmin
    .from('plan_prices')
    .select('duration_unit, duration_value, plan_id, price')
    .eq('id', planPriceId)
    .single();

  if (!planPrice) throw new Error("Plan price not found during activation");

  // Fetch the associated plan to get max_members and max_gyms
  const { data: plan } = await supabaseAdmin
    .from('plans')
    .select('max_members, max_gyms')
    .eq('id', planPrice.plan_id)
    .single();

  // Fetch existing subscription to append time/metadata
  const { data: existingSub } = await supabaseAdmin
    .from('subscriptions')
    .select('*')
    .eq('id', subscriptionId)
    .single();

  if (!existingSub || !plan) throw new Error("Subscription or Plan not found during activation");

  const now = new Date();
  let currentStart = now;
  let currentEnd = new Date(now);

  if (planPrice.duration_unit === 'month') {
    currentEnd.setMonth(currentEnd.getMonth() + planPrice.duration_value);
  } else if (planPrice.duration_unit === 'year') {
    currentEnd.setFullYear(currentEnd.getFullYear() + planPrice.duration_value);
  }

  const extraG = finalExtraG !== null ? finalExtraG : (existingSub.extra_gyms || 0);
  const extraM = finalExtraM !== null ? finalExtraM : (existingSub.extra_members || 0);

  // 1. Mark old subscriptions as expired
  await supabaseAdmin
    .from('subscriptions')
    .update({ status: 'expired' })
    .eq('user_id', existingSub.user_id)
    .in('status', ['active', 'trial', 'Active', 'Trial']);

  // 2. Insert NEW Subscription
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
      amount: txData?.amount_total || planPrice.price
    })
    .select()
    .single();

  if (subInsertError || !newSub) throw new Error("Failed to insert new subscription record");

  // 3. Update transaction to success and link to new subscription
  await supabaseAdmin
    .from('subscription_transactions')
    .update({
      subscription_id: newSub.id,
      status: 'success'
    })
    .eq('id', transactionId);

  // 4. Sync Features
  const { data: planFeatures } = await supabaseAdmin
    .from('plan_features')
    .select('feature_id, value')
    .eq('plan_id', planPrice.plan_id);

  if (planFeatures && planFeatures.length > 0) {
    const newFeatures = planFeatures.map(f => ({
      subscription_id: newSub.id,
      feature_id: f.feature_id,
      value: f.value
    }));
    await supabaseAdmin.from('subscription_features').insert(newFeatures);
  }

  return newSub;
};

export const createSubscriptionOrder = async (req: Request, res: Response) => {
  try {
    const { userId, planPriceId, subscriptionId, extra_gyms = 0, extra_members = 0, couponCode } = req.body;

    if (!userId || !planPriceId || !subscriptionId) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    // 0. EXTENSION DECREASE PREVENTION: Verify extensions are not being decreased
    const { data: currentSubscription } = await supabaseAdmin
      .from('subscriptions')
      .select('extra_gyms, extra_members')
      .eq('id', subscriptionId)
      .maybeSingle();

    if (currentSubscription) {
      const currentExtraGyms = currentSubscription.extra_gyms || 0;
      const currentExtraMembers = currentSubscription.extra_members || 0;

      if (extra_gyms < currentExtraGyms) {
        return res.status(400).json({
          error: `Extra gyms cannot be decreased. Current: ${currentExtraGyms}, Requested: ${extra_gyms}. Extensions can only be maintained or increased during plan purchase.`,
          code: 'EXTENSION_DECREASE_NOT_ALLOWED'
        });
      }

      if (extra_members < currentExtraMembers) {
        return res.status(400).json({
          error: `Extra members cannot be decreased. Current: ${currentExtraMembers}, Requested: ${extra_members}. Extensions can only be maintained or increased during plan purchase.`,
          code: 'EXTENSION_DECREASE_NOT_ALLOWED'
        });
      }
    }

    // 1. Fetch the actual plan price
    const { data: planPrice, error: priceError } = await supabaseAdmin
      .from('plan_prices')
      .select('price, duration_unit, duration_value, plan_id')
      .eq('id', planPriceId)
      .single();

    if (priceError || !planPrice) {
      return res.status(404).json({ error: 'Plan price not found' });
    }

    // 1b. DOWNGRADE PREVENTION: Check if user is trying to purchase a lower-tier plan
    // while their current subscription is still active
    const { data: activeSubscription } = await supabaseAdmin
      .from('subscriptions')
      .select('plan_id, status, end_date')
      .eq('user_id', userId)
      .in('status', ['active', 'Active'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (activeSubscription && new Date(activeSubscription.end_date) > new Date()) {
      // Fetch the current plan's tier identifier (using max_gyms as tier indicator)
      const { data: currentPlan } = await supabaseAdmin
        .from('plans')
        .select('max_gyms, max_members')
        .eq('id', activeSubscription.plan_id)
        .maybeSingle();

      // Fetch the target plan's tier identifier
      const { data: targetPlan } = await supabaseAdmin
        .from('plans')
        .select('max_gyms, max_members')
        .eq('id', planPrice.plan_id)
        .maybeSingle();

      if (currentPlan && targetPlan) {
        // A plan is considered "lower" if it has fewer max_gyms OR fewer max_members
        const isDowngrade =
          targetPlan.max_gyms < currentPlan.max_gyms ||
          targetPlan.max_members < currentPlan.max_members;

        if (isDowngrade) {
          return res.status(400).json({
            error: 'Cannot downgrade your plan while your current subscription is active. Please wait until your current plan expires or contact support.',
            code: 'DOWNGRADE_NOT_ALLOWED'
          });
        }
      }
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

    // --- COUPON VALIDATION ---
    let couponDiscount = 0;
    let couponId = null;

    if (couponCode) {
      // 1. Fetch Coupon Data
      const { data: coupon, error: couponError } = await supabaseAdmin
        .from('coupons')
        .select('*')
        .eq('code', couponCode.trim().toUpperCase())
        .eq('is_active', true)
        .single();

      if (couponError || !coupon) {
        return res.status(400).json({ error: 'Invalid or inactive coupon code' });
      }

      // 2. Check Expiry
      if (coupon.expiry_date && new Date(coupon.expiry_date) < new Date()) {
        return res.status(400).json({ error: 'This coupon has expired' });
      }

      // 3. Check Minimum Purchase
      const totalAmountBeforeDiscount = planPrice.price + extensionCharge;
      if (Math.round(totalAmountBeforeDiscount) < coupon.min_purchase_amount) {
        return res.status(400).json({ error: `Minimum purchase amount not met (Min: ₹${coupon.min_purchase_amount})` });
      }

      // 4. Check Multi-Plan Restriction (Array check)
      if (coupon.applicable_plan_ids && planPrice.plan_id) {
        const currentPlanIdStr = String(planPrice.plan_id);
        const allowedPlanIds = coupon.applicable_plan_ids.map((id: any) => String(id));
        
        if (!allowedPlanIds.includes(currentPlanIdStr)) {
          return res.status(400).json({ error: 'This coupon is not applicable to the selected plan' });
        }
      }

      // 5. Check Multi-Duration Restriction (Array check)
      if (coupon.applicable_duration_units && !coupon.applicable_duration_units.includes(planPrice.duration_unit)) {
        return res.status(400).json({ error: `This coupon is not valid for ${planPrice.duration_unit}ly subscriptions` });
      }

      // 6. Check Usage Limits
      const { count: totalUsageCount } = await supabaseAdmin
        .from('coupon_usage')
        .select('*', { count: 'exact', head: true })
        .eq('coupon_id', coupon.id);

      if (coupon.total_usage_limit !== null && (totalUsageCount || 0) >= coupon.total_usage_limit) {
        return res.status(400).json({ error: 'This coupon usage limit has been reached' });
      }

      const { count: userUsageCount } = await supabaseAdmin
        .from('coupon_usage')
        .select('*', { count: 'exact', head: true })
        .eq('coupon_id', coupon.id)
        .eq('user_id', userId);

      if ((userUsageCount || 0) >= coupon.user_usage_limit) {
        return res.status(400).json({ error: 'You have already used this coupon' });
      }

      // 7. Calculate Discount
      if (coupon.discount_type === 'FLAT') {
        couponDiscount = coupon.discount_value;
      } else {
        couponDiscount = (totalAmountBeforeDiscount * coupon.discount_value) / 100;
        if (coupon.max_discount_amount && couponDiscount > coupon.max_discount_amount) {
          couponDiscount = coupon.max_discount_amount;
        }
      }
      couponId = coupon.id;
    }

    // --- PRO-RATING LOGIC (CARRY-OVER BALANCE) ---
    let carriedCredit = 0;
    let extensionCarryOverCredit = 0;
    let extensionCreditBreakdown: { type: string; originalAmount: number; credit: number; daysRemaining: number; totalDays: number }[] = [];
    const { data: currentSub } = await supabaseAdmin
      .from('subscriptions')
      .select('id, amount, start_date, end_date, status, plan_price_id, plan_id')
      .eq('user_id', userId)
      .in('status', ['active', 'Active'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (currentSub && currentSub.plan_price_id) {
      const now = new Date();
      const startDate = new Date(currentSub.start_date);
      const endDate = new Date(currentSub.end_date);

      if (endDate > now) {
        // Fetch the PREVIOUS plan's base price (without extensions)
        const { data: previousPlanPrice } = await supabaseAdmin
          .from('plan_prices')
          .select('price')
          .eq('id', currentSub.plan_price_id)
          .maybeSingle();

        if (previousPlanPrice && previousPlanPrice.price > 0) {
          const msInDay = 24 * 60 * 60 * 1000;
          const totalDurationDays = Math.max(1, Math.ceil((endDate.getTime() - startDate.getTime()) / msInDay));
          const remainingDays = Math.max(0, Math.ceil((endDate.getTime() - now.getTime()) / msInDay));

          // Calculate credit based on PREVIOUS PLAN'S base price and remaining days
          carriedCredit = Math.floor((previousPlanPrice.price / totalDurationDays) * remainingDays);
          console.log(`User ${userId} has ${remainingDays} days left on previous plan. Credit: ₹${carriedCredit} (based on plan price ₹${previousPlanPrice.price})`);

          // --- EXTENSION PRO-RATED CREDIT ---
          // Fetch extension addons for the current subscription to calculate unused value
          const { data: addons } = await supabaseAdmin
            .from('subscription_addons')
            .select('*')
            .eq('subscription_id', currentSub.id);

          if (addons && addons.length > 0) {
            const msInDay = 24 * 60 * 60 * 1000;

            for (const addon of addons) {
              const addonPurchaseDate = new Date(addon.created_at);
              const addonTotalDays = Math.max(1, Math.ceil((endDate.getTime() - addonPurchaseDate.getTime()) / msInDay));
              const addonRemainingDays = Math.max(0, Math.ceil((endDate.getTime() - now.getTime()) / msInDay));

              if (addonRemainingDays > 0 && addonTotalDays > 0) {
                const proRateRatio = addonRemainingDays / addonTotalDays;
                const addonCredit = Math.floor(addon.amount_paid * proRateRatio);

                extensionCarryOverCredit += addonCredit;
                extensionCreditBreakdown.push({
                  type: addon.type,
                  originalAmount: addon.amount_paid,
                  credit: addonCredit,
                  daysRemaining: addonRemainingDays,
                  totalDays: addonTotalDays
                });

                console.log(`Extension addon ${addon.type}: ${addonRemainingDays}/${addonTotalDays} days unused. Credit: ₹${addonCredit} (original: ₹${addon.amount_paid})`);
              }
            }
          }
        }
      }
    }

    const totalCarryOverCredit = carriedCredit + extensionCarryOverCredit;

    // Final Amount to charge (Plan Price + Extensions - Coupon - Total Carried Credit)
    const baseTotal = planPrice.price + extensionCharge;
    const discountedTotal = Math.max(0, baseTotal - couponDiscount);
    const amountTotal = Math.max(0, discountedTotal - totalCarryOverCredit);
    const amountInPaise = Math.round(amountTotal * 100);

    // --- HANDLE FREE SUBSCRIPTION (100% Discount) ---
    if (amountTotal === 0) {
      console.log(`Processing FREE subscription for user ${userId} (100% discount applied)`);
      
      const receiptId = `FREE-${crypto.randomUUID().split('-')[0]}`;
      
      // Since it's free, we don't need Razorpay. We create a 'paid' transaction immediately.
      const { data: transaction, error: txError } = await supabaseAdmin
        .from('subscription_transactions')
        .insert({
          user_id: userId,
          subscription_id: subscriptionId,
          plan_price_id: planPriceId,
          status: 'paid', // Mark as paid immediately
          receipt_id: receiptId,
          amount_total: 0,
          amount_paid: 0,
          razorpay_order_id: 'FREE_ORDER_' + receiptId,
          applied_coupon_id: couponId,
          discount_amount: couponDiscount,
          metadata: { extra_gyms, extra_members, isFree: true }
        })
        .select('id')
        .single();

      if (txError) throw txError;

      // --- ACTIVATE IMMEDIATELY ---
      const newSub = await activateSubscriptionInDB(transaction.id, planPriceId, subscriptionId);

      return res.json({
        isFree: true,
        transactionId: transaction.id,
        subscriptionId: newSub.id,
        message: 'Subscription activated for free!'
      });
    }

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
        extension_carry_over_credit: extensionCarryOverCredit.toString(),
        total_carry_over_credit: totalCarryOverCredit.toString(),
        original_price: baseTotal.toString(),
        coupon_id: couponId,
        coupon_discount: couponDiscount.toString()
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
        applied_coupon_id: couponId,
        discount_amount: couponDiscount,
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
      .select('metadata, amount_total, applied_coupon_id, user_id')
      .eq('id', transactionId)
      .single();

    const meta = txData?.metadata as any || {};
    const finalExtraG = typeof meta.extra_gyms !== 'undefined' ? Number(meta.extra_gyms) : null;
    const finalExtraM = typeof meta.extra_members !== 'undefined' ? Number(meta.extra_members) : null;

    // 2. Fetch specific payment info to get fee, tax, and method
    const paymentInfo = await razorpay.payments.fetch(razorpay_payment_id);
    const feeInRupees = paymentInfo.fee ? Number(paymentInfo.fee) / 100 : null;
    const taxInRupees = paymentInfo.tax ? Number(paymentInfo.tax) / 100 : null;

    // Generate Invoice Number Sequentially (Unified INV prefix)
    const invoiceNumber = await getNextInvoiceNumber('INV');

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
      .eq('id', transactionId)
      .select('applied_coupon_id, user_id')
      .single();

    if (txUpdateError) {
      console.error("Failed to update transaction status", txUpdateError);
    }

    // --- ACTIVATE SUBSCRIPTION ---
    await activateSubscriptionInDB(transactionId, planPriceId, subscriptionId);

    res.json({ success: true, message: 'Payment verified and subscription activated.' });

  } catch (error: any) {
    console.error("Payment verification error:", error);
    res.status(500).json({ error: 'Internal server error during verification' });
  }
};

export const getInvoiceDetails = async (req: Request, res: Response) => {
  try {
    const { transactionId } = req.params;

    // Fetch transaction details including user and subscription info
    const { data: tx, error: txError } = await supabaseAdmin
      .from('subscription_transactions')
      .select(`
        *,
        subscriptions (
          *,
          plans (name, description),
          plan_prices (duration_unit, duration_value)
        )
      `)
      .eq('id', transactionId)
      .single();

    if (txError || !tx) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    // Try to get user ID from transaction, fall back to subscription if needed
    const userId = tx.user_id || tx.subscriptions?.user_id;

    let customerName = 'Valued Customer';
    let customerEmail = 'N/A';

    if (userId) {
      // 1. Fetch Auth User info (for email and metadata)
      const { data: userData } = await supabaseAdmin.auth.admin.getUserById(userId);
      const user = userData?.user;

      if (user) {
        customerEmail = user.email || 'N/A';

        // 2. Fetch Profile (Sidebar style)
        const { data: profile } = await supabaseAdmin
          .from('profiles')
          .select('full_name')
          .eq('user_id', userId)
          .maybeSingle();

        // 3. Name Priority: Profile > User Metadata > Email Prefix
        customerName = profile?.full_name ||
          user.user_metadata?.full_name ||
          user.user_metadata?.name ||
          user.email?.split('@')[0] ||
          'Valued Customer';
      }
    }

    // If it's an extension, get those details
    let extensionDetails = null;
    if (tx.metadata && (tx.metadata.extra_gyms || tx.metadata.extra_members)) {
      extensionDetails = tx.metadata;
    } else {
      // Check subscription_addons for this transaction
      const { data: addon } = await supabaseAdmin
        .from('subscription_addons')
        .select('*')
        .eq('transaction_id', transactionId)
        .maybeSingle();
      if (addon) extensionDetails = addon;
    }

    // Unified fallback prefix 'INV' for all transaction types
    const fallbackPrefix = 'INV';
    const fallbackNumber = `${fallbackPrefix}-${new Date(tx.created_at).getFullYear()}-${tx.id.toString().substring(0, 8).toUpperCase()}`;

    res.json({
      invoice: {
        number: tx.invoice_number || fallbackNumber,
        date: tx.created_at,
        amount: tx.amount_total,
        payment_method: tx.payment_method || 'Razorpay',
        status: tx.status,
        razorpay_payment_id: tx.razorpay_payment_id
      },
      customer: {
        name: customerName,
        email: customerEmail,
      },
      items: [
        {
          name: tx.subscriptions?.plans?.name || 'Gym Subscription',
          description: tx.subscriptions ? `${tx.subscriptions.plan_prices?.duration_value} ${tx.subscriptions.plan_prices?.duration_unit}(s)` : 'N/A',
          amount: tx.amount_total,
          isExtension: !!extensionDetails,
          extensionDetails
        }
      ]
    });

  } catch (error) {
    console.error("Error fetching invoice details:", error);
    res.status(500).json({ error: 'Failed to fetch invoice' });
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

    // 2. Fetch Extension Add-ons and Transactions for these subscriptions
    const subIds = subs?.map(s => s.id) || [];
    const { data: addons } = subIds.length > 0 ? await supabaseAdmin
      .from('subscription_addons')
      .select('*')
      .in('subscription_id', subIds) : { data: [] };

    const { data: txs } = subIds.length > 0 ? await supabaseAdmin
      .from('subscription_transactions')
      .select('id, subscription_id, invoice_number, status')
      .in('subscription_id', subIds)
      .eq('status', 'success') : { data: [] };

    // 3. Nest Add-ons into their parent Subscriptions
    const nestedHistory = (subs || []).map(s => {
      const subAddons = (addons || [])
        .filter(a => a.subscription_id === s.id)
        .map(a => {
          const addonTx = (txs || []).find(t => t.id === a.transaction_id);
          return {
            id: a.id,
            tx_id: a.transaction_id,
            invoice_number: addonTx?.invoice_number || 'N/A',
            isAddon: true,
            name: `Extra ${a.quantity} ${a.type}${a.quantity > 1 ? 's' : ''}`,
            amount: a.amount_paid,
            status: 'active',
            created_at: a.created_at,
            duration: s.plan_prices ? `${s.plan_prices.duration_value} ${s.plan_prices.duration_unit}(s)` : 'N/A', // Match Parent Duration
            quantity: a.quantity,
            type: a.type
          };
        })
        .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

      const subTx = (txs || []).find(t => t.subscription_id === s.id && t.invoice_number?.startsWith('INV-2'));

      return {
        id: s.id,
        tx_id: subTx?.id || null,
        invoice_number: subTx?.invoice_number || 'N/A',
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
    const { userId, type, quantity, subscriptionId, couponCode } = req.body;

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

    const itemBaseTotal = (quantity / pricing.unit_quantity) * pricing.unit_price;
    const proRatedBaseTotal = itemBaseTotal * durationRatio;

    // --- COUPON VALIDATION (Extensions) ---
    let couponDiscount = 0;
    let couponId = null;

    if (couponCode) {
      // 1. Fetch Coupon Data
      const { data: coupon, error: couponError } = await supabaseAdmin
        .from('coupons')
        .select('*')
        .eq('code', couponCode.trim().toUpperCase())
        .eq('is_active', true)
        .eq('is_applicable_to_extensions', true)
        .single();

      if (couponError || !coupon) {
        return res.status(400).json({ error: 'Invalid coupon or coupon not applicable to extensions' });
      }

      // 2. Check Expiry
      if (coupon.expiry_date && new Date(coupon.expiry_date) < new Date()) {
        return res.status(400).json({ error: 'This coupon has expired' });
      }

      // 3. Check Minimum Purchase
      if (Math.round(proRatedBaseTotal) < coupon.min_purchase_amount) {
        return res.status(400).json({ error: `Minimum purchase amount not met (Min: ₹${coupon.min_purchase_amount})` });
      }

      // 4. Check Usage Limits
      const { count: totalUsageCount } = await supabaseAdmin
        .from('coupon_usage')
        .select('*', { count: 'exact', head: true })
        .eq('coupon_id', coupon.id);

      if (coupon.total_usage_limit !== null && (totalUsageCount || 0) >= coupon.total_usage_limit) {
        return res.status(400).json({ error: 'This coupon usage limit has been reached' });
      }

      const { count: userUsageCount } = await supabaseAdmin
        .from('coupon_usage')
        .select('*', { count: 'exact', head: true })
        .eq('coupon_id', coupon.id)
        .eq('user_id', userId);

      if ((userUsageCount || 0) >= coupon.user_usage_limit) {
        return res.status(400).json({ error: 'You have already used this coupon' });
      }

      // 5. Calculate Discount
      if (coupon.discount_type === 'FLAT') {
        couponDiscount = coupon.discount_value;
      } else {
        couponDiscount = (proRatedBaseTotal * coupon.discount_value) / 100;
        if (coupon.max_discount_amount && couponDiscount > coupon.max_discount_amount) {
          couponDiscount = coupon.max_discount_amount;
        }
      }
      couponId = coupon.id;
    }

    const amountTotal = Math.max(1, Math.round(proRatedBaseTotal - couponDiscount));
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
        quantity: quantity.toString(),
        coupon_id: couponId,
        coupon_discount: couponDiscount.toString()
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
        applied_coupon_id: couponId,
        discount_amount: couponDiscount,
        metadata: {
          type: type,
          quantity: quantity,
          isExtension: true
        }
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
      type, // Fallback field
      quantity
    } = req.body;

    const finalType = extensionType || type;

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

    // 3. Update Transaction with Unified Sequential Invoice (INV prefix)
    const extensionInvoice = await getNextInvoiceNumber('INV');

    const { data: txData, error: txUpdateError } = await supabaseAdmin
      .from('subscription_transactions')
      .update({
        status: 'success',
        razorpay_payment_id,
        razorpay_signature,
        payment_method: paymentInfo.method || 'unknown',
        razorpay_fee: fee,
        razorpay_tax: tax,
        invoice_number: extensionInvoice
      })
      .eq('id', transactionId)
      .select('applied_coupon_id, user_id')
      .single();

    if (txUpdateError) {
      console.error("Critical: Failed to update transaction invoice_number", txUpdateError);
    }

    // Record Coupon Usage
    if (txData?.applied_coupon_id) {
      await supabaseAdmin.from('coupon_usage').insert({
        coupon_id: txData.applied_coupon_id,
        user_id: txData.user_id || req.body.userId,
        transaction_id: transactionId
      });
    }

    // 4. Fetch the existing subscription
    const { data: sub } = await supabaseAdmin
      .from('subscriptions')
      .select('*')
      .eq('id', subscriptionId)
      .single();

    if (sub) {
      const typeLower = (finalType || 'gym').toLowerCase();
      const isGym = typeLower.startsWith('gym');
      const isMember = typeLower.startsWith('member');

      console.log(`Verifying payment for ${finalType}. Classified as - Gym: ${isGym}, Member: ${isMember}`);

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
