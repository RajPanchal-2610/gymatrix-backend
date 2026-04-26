import { Request, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export const getCoupons = async (req: Request, res: Response) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('coupons')
      .select(`
        *,
        usage_count:coupon_usage(count)
      `)
      .order('created_at', { ascending: false });

    if (error) throw error;

    // Transform count from nested object
    const transformed = data.map((c: any) => ({
      ...c,
      usage_count: c.usage_count?.[0]?.count || 0
    }));

    res.json(transformed);
  } catch (error: any) {
    console.error("Get coupons error:", error);
    res.status(500).json({ error: 'Failed to fetch coupons' });
  }
};

export const createCoupon = async (req: Request, res: Response) => {
  try {
    const couponData = req.body;

    // Validate required fields
    if (!couponData.code || !couponData.discount_type || !couponData.discount_value) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const { data, error } = await supabaseAdmin
      .from('coupons')
      .insert([couponData])
      .select()
      .single();

    if (error) {
      if (error.code === '23505') return res.status(400).json({ error: 'Coupon code already exists' });
      throw error;
    }

    res.status(201).json(data);
  } catch (error: any) {
    console.error("Create coupon error:", error);
    res.status(500).json({ error: 'Failed to create coupon' });
  }
};

export const updateCoupon = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const { data, error } = await supabaseAdmin
      .from('coupons')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    res.json(data);
  } catch (error: any) {
    console.error("Update coupon error:", error);
    res.status(500).json({ error: 'Failed to update coupon' });
  }
};

export const validateCoupon = async (req: Request, res: Response) => {
  try {
    const { code, userId, planId, duration, amount, type } = req.body;

    if (!code || !userId) {
      return res.status(400).json({ error: 'Code and User ID are required' });
    }

    // 1. Fetch coupon
    const { data: coupon, error } = await supabaseAdmin
      .from('coupons')
      .select('*')
      .eq('code', code.toUpperCase())
      .single();

    if (error || !coupon) {
      return res.status(404).json({ error: 'Coupon code not found' });
    }

    // 2. Generic Validations
    if (!coupon.is_active) return res.status(400).json({ error: 'Coupon is inactive' });
    if (coupon.expiry_date && new Date(coupon.expiry_date) < new Date()) {
      return res.status(400).json({ error: 'Coupon has expired' });
    }

    // 3. Plan/Duration restrictions (Array-based)
    if (coupon.applicable_plan_ids && planId) {
      const planIdStr = String(planId);
      const allowedPlanIds = coupon.applicable_plan_ids.map((id: any) => String(id));
      
      if (!allowedPlanIds.includes(planIdStr)) {
        return res.status(400).json({ error: 'This coupon is not applicable to the selected plan' });
      }
    }
    if (coupon.applicable_duration_units && duration && !coupon.applicable_duration_units.includes(duration)) {
      return res.status(400).json({ error: `This coupon is not valid for ${duration}ly subscriptions` });
    }

    // 4. Extension check
    const isExtension = type === 'extension';
    if (isExtension && !coupon.is_applicable_to_extensions) {
      return res.status(400).json({ error: 'This coupon is not applicable for extensions' });
    }

    // 5. Amount check
    if (amount < coupon.min_purchase_amount) {
      return res.status(400).json({ error: `Minimum purchase of ₹${coupon.min_purchase_amount} required` });
    }

    // 6. Global Usage limit
    if (coupon.total_usage_limit) {
      const { count } = await supabaseAdmin
        .from('coupon_usage')
        .select('*', { count: 'exact', head: true })
        .eq('coupon_id', coupon.id);

      if (count !== null && count >= coupon.total_usage_limit) {
        return res.status(400).json({ error: 'Coupon usage limit reached' });
      }
    }

    // 7. Per-User Usage limit
    if (coupon.user_usage_limit) {
      const { count } = await supabaseAdmin
        .from('coupon_usage')
        .select('*', { count: 'exact', head: true })
        .eq('coupon_id', coupon.id)
        .eq('user_id', userId);

      if (count !== null && count >= coupon.user_usage_limit) {
        return res.status(400).json({ error: 'You have already used this coupon' });
      }
    }

    // 8. Calculate Discount
    let discount = 0;
    if (coupon.discount_type === 'FLAT') {
      discount = coupon.discount_value;
    } else {
      discount = (amount * coupon.discount_value) / 100;
      if (coupon.max_discount_amount && discount > coupon.max_discount_amount) {
        discount = coupon.max_discount_amount;
      }
    }

    res.json({
      valid: true,
      couponId: coupon.id,
      discount: Math.round(discount),
      discountType: coupon.discount_type,
      discountValue: coupon.discount_value
    });

  } catch (error: any) {
    console.error("Validate coupon error:", error);
    res.status(500).json({ error: 'Failed to validate coupon' });
  }
};

/**
 * Fetches the list of users who have used a specific coupon
 */
export const getCouponUsage = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // 1. Fetch usage and transaction data
    const { data: usageData, error: usageError } = await supabaseAdmin
      .from('coupon_usage')
      .select(`
        id,
        used_at,
        user_id,
        transaction:transaction_id(
          id,
          amount_total,
          status,
          created_at,
          receipt_id,
          plan_prices:plan_price_id(
            price,
            duration_unit,
            plans:plan_id(name)
          )
        )
      `)
      .eq('coupon_id', id)
      .order('used_at', { ascending: false });

    if (usageError) throw usageError;

    if (!usageData || usageData.length === 0) {
      return res.json([]);
    }

    // 2. Fetch profiles for all users involved
    const userIds = [...new Set(usageData.map(u => u.user_id))];
    const { data: profileData, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('user_id, full_name')
      .in('user_id', userIds);

    if (profileError) {
      console.warn("Failed to fetch profiles, continuing with unknown names:", profileError);
    }

    // Create a map for quick lookup
    const profileMap = new Map(profileData?.map(p => [p.user_id, p.full_name]) || []);

    // 3. Map everything together
    const transformed = usageData.map((item: any) => ({
      usageId: item.id,
      date: item.used_at,
      userName: profileMap.get(item.user_id) || 'Unknown User',
      userEmail: 'N/A',
      transactionId: item.transaction?.id,
      amount: item.transaction?.amount_total || 0,
      status: item.transaction?.status,
      receiptId: item.transaction?.receipt_id,
      planName: item.transaction?.plan_prices?.plans?.name || 'Unknown Plan',
      duration: item.transaction?.plan_prices?.duration_unit
    }));

    res.json(transformed);
  } catch (error: any) {
    console.error("Get coupon usage error:", error);
    res.status(500).json({ error: error.message || 'Failed to fetch coupon usage details' });
  }
};

/**
 * Deletes a coupon (and its usage history via CASCADE if set in DB)
 */
export const deleteCoupon = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // 1. First, we must check if there are any usages. 
    // If usage exists, we might want to prevent deletion or just delete usage too.
    // In this implementation, we will delete the coupon and its usage history.
    
    // Delete usage records first (if foreign key doesn't have CASCADE)
    await supabaseAdmin.from('coupon_usage').delete().eq('coupon_id', id);

    const { error } = await supabaseAdmin
      .from('coupons')
      .delete()
      .eq('id', id);

    if (error) throw error;

    res.json({ success: true, message: 'Coupon deleted successfully' });
  } catch (error: any) {
    console.error("Delete coupon error:", error);
    res.status(500).json({ error: 'Failed to delete coupon' });
  }
};
