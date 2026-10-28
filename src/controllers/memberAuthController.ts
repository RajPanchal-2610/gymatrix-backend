import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { supabaseAdmin } from '../lib/supabase';
import { AuthenticatedMemberRequest } from '../middleware/memberAuthMiddleware';

const JWT_SECRET = process.env.JWT_SECRET || 'gymatrix_member_jwt_secret_2026_super_secure';

// Helper to normalize phone numbers (extract last 10 digits)
const extract10Digits = (phone: string): string => {
  const digits = (phone || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : digits;
};

// 1. REGISTER MEMBER (Phone + Password)
export const registerMember = async (req: Request, res: Response) => {
  try {
    const { phone, password, fullName, email, gymId } = req.body;

    if (!phone || !password) {
      return res.status(400).json({ error: 'Phone number and password are required' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters long' });
    }

    const last10 = extract10Digits(phone);
    if (last10.length < 10) {
      return res.status(400).json({ error: 'Please enter a valid 10-digit mobile number' });
    }

    // Check if a member record with this phone already exists in gym_members
    const { data: existingMembers, error: searchErr } = await supabaseAdmin
      .from('gym_members')
      .select('id, gym_id, full_name, phone, email, password_hash, status, expiry_date')
      .eq('is_deleted', false)
      .ilike('phone', `%${last10}%`);

    if (searchErr) throw searchErr;

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);
    let memberRecord: any = null;

    if (existingMembers && existingMembers.length > 0) {
      // Pick the first existing member record
      const existing = existingMembers[0];

      if (existing.password_hash) {
        return res.status(400).json({
          error: 'An account is already registered with this mobile number. Please log in.',
        });
      }

      // Member was pre-added by gym staff, now activating their password
      const { data: updatedMember, error: updateErr } = await supabaseAdmin
        .from('gym_members')
        .update({
          password_hash: passwordHash,
          full_name: fullName || existing.full_name,
          email: email || existing.email,
          last_login: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing.id)
        .select('id, gym_id, full_name, phone, email, status, expiry_date')
        .single();

      if (updateErr) throw updateErr;
      memberRecord = updatedMember;
    } else {
      // New self-registering member
      let targetGymId = gymId;
      if (!targetGymId) {
        // Fallback to first available gym
        const { data: defaultGym } = await supabaseAdmin
          .from('gyms')
          .select('id')
          .limit(1)
          .maybeSingle();
        targetGymId = defaultGym?.id || 1;
      }

      const { data: newMember, error: insertErr } = await supabaseAdmin
        .from('gym_members')
        .insert({
          gym_id: targetGymId,
          full_name: fullName || 'Gym Member',
          phone: phone.trim(),
          email: email?.trim() || null,
          password_hash: passwordHash,
          join_date: new Date().toISOString().split('T')[0],
          status: 'active',
          is_active: true,
          is_deleted: false,
          last_login: new Date().toISOString(),
        })
        .select('id, gym_id, full_name, phone, email, status, expiry_date')
        .single();

      if (insertErr) throw insertErr;
      memberRecord = newMember;
    }

    // Get gym details
    const { data: gymData } = await supabaseAdmin
      .from('gyms')
      .select('id, name, logo_url')
      .eq('id', memberRecord.gym_id)
      .maybeSingle();

    // Sign JWT token valid for 30 days
    const token = jwt.sign(
      {
        id: memberRecord.id,
        gym_id: memberRecord.gym_id,
        phone: memberRecord.phone,
        role: 'MEMBER',
      },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    return res.status(201).json({
      message: 'Account registered successfully',
      token,
      member: {
        id: memberRecord.id,
        full_name: memberRecord.full_name,
        phone: memberRecord.phone,
        email: memberRecord.email,
        gym_id: memberRecord.gym_id,
        gym_name: gymData?.name || 'Gymatrix Gym',
        gym_logo: gymData?.logo_url || null,
        status: memberRecord.status,
        expiry_date: memberRecord.expiry_date,
      },
    });
  } catch (error: any) {
    console.error('Member register error:', error);
    res.status(500).json({ error: error.message || 'Registration failed' });
  }
};

// 2. LOGIN MEMBER (Phone + Password)
export const loginMember = async (req: Request, res: Response) => {
  try {
    const { phone, password } = req.body;

    if (!phone || !password) {
      return res.status(400).json({ error: 'Mobile number and password are required' });
    }

    const last10 = extract10Digits(phone);
    if (last10.length < 10) {
      return res.status(400).json({ error: 'Please enter a valid 10-digit mobile number' });
    }

    // Find member by matching the last 10 digits of phone
    const { data: members, error: searchErr } = await supabaseAdmin
      .from('gym_members')
      .select(`
        id, 
        gym_id, 
        full_name, 
        phone, 
        email, 
        password_hash, 
        status, 
        expiry_date,
        image_url,
        gym_membership_plans (
          id, 
          name, 
          price
        ),
        gyms (
          id, 
          name, 
          logo_url
        )
      `)
      .eq('is_deleted', false)
      .ilike('phone', `%${last10}%`);

    if (searchErr) throw searchErr;

    if (!members || members.length === 0) {
      return res.status(404).json({
        error: 'No member found with this mobile number. Please register first or contact your gym.',
      });
    }

    const member = members[0];

    if (!member.password_hash) {
      return res.status(400).json({
        error: "You haven't set a password yet. Please click 'Register / Set Password' to activate your account.",
        needsRegistration: true,
      });
    }

    // Compare entered password with stored bcrypt hash
    const isPasswordValid = await bcrypt.compare(password, member.password_hash);
    if (!isPasswordValid) {
      return res.status(401).json({ error: 'Incorrect password. Please try again.' });
    }

    // Update last_login timestamp asynchronously
    await supabaseAdmin
      .from('gym_members')
      .update({ last_login: new Date().toISOString() })
      .eq('id', member.id);

    // Sign JWT token
    const token = jwt.sign(
      {
        id: member.id,
        gym_id: member.gym_id,
        phone: member.phone,
        role: 'MEMBER',
      },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    const gymInfo = Array.isArray(member.gyms) ? member.gyms[0] : member.gyms;
    const planInfo = Array.isArray(member.gym_membership_plans)
      ? member.gym_membership_plans[0]
      : member.gym_membership_plans;

    return res.json({
      message: 'Login successful',
      token,
      member: {
        id: member.id,
        full_name: member.full_name,
        phone: member.phone,
        email: member.email,
        image_url: member.image_url,
        gym_id: member.gym_id,
        gym_name: gymInfo?.name || 'Gymatrix Gym',
        gym_logo: gymInfo?.logo_url || null,
        status: member.status,
        expiry_date: member.expiry_date,
        plan_name: planInfo?.name || 'No Active Plan',
      },
    });
  } catch (error: any) {
    console.error('Member login error:', error);
    res.status(500).json({ error: error.message || 'Login failed' });
  }
};

// 3. GET CURRENT LOGGED-IN MEMBER PROFILE
export const getMemberMe = async (req: AuthenticatedMemberRequest, res: Response) => {
  try {
    const memberId = req.member?.id;

    const { data: member, error } = await supabaseAdmin
      .from('gym_members')
      .select(`
        id,
        gym_id,
        full_name,
        phone,
        email,
        join_date,
        expiry_date,
        status,
        image_url,
        gender,
        pt_fee,
        assigned_staff_id,
        gym_membership_plans (
          id,
          name,
          price,
          duration_value,
          duration_unit
        ),
        gyms (
          id,
          name,
          logo_url
        ),
        gym_staff (
          id,
          full_name,
          phone
        )
      `)
      .eq('id', memberId)
      .single();

    if (error || !member) {
      return res.status(404).json({ error: 'Member not found' });
    }

    res.json(member);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to fetch member profile' });
  }
};

// 4. GET MEMBER DASHBOARD FULL DATA BUNDLE
export const getMemberDashboardData = async (req: AuthenticatedMemberRequest, res: Response) => {
  try {
    const memberId = req.member?.id;
    const gymId = req.member?.gym_id;

    // 1. Fetch Member Details
    const { data: member } = await supabaseAdmin
      .from('gym_members')
      .select(`
        *,
        gym_membership_plans (id, name, price, duration_value, duration_unit),
        gyms (id, name, logo_url),
        gym_staff (id, full_name, phone)
      `)
      .eq('id', memberId)
      .single();

    if (!member) {
      return res.status(404).json({ error: 'Member not found' });
    }

    // 2. Fetch Attendance (last 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const { data: attendance } = await supabaseAdmin
      .from('gym_member_attendance')
      .select('id, date, check_in_time, check_out_time, status')
      .eq('member_id', memberId)
      .gte('date', thirtyDaysAgo.toISOString().split('T')[0])
      .order('date', { ascending: false });

    // 3. Fetch Payment Receipts & Invoices
    const { data: payments, error: paymentsErr } = await supabaseAdmin
      .from('gym_membership_payments')
      .select(`
        id,
        total_amount,
        paid_amount,
        due_amount,
        payment_status,
        billing_date,
        created_at,
        remarks,
        gym_membership_history (
          id,
          start_date,
          end_date,
          plan_id,
          gym_membership_plans (
            id,
            name
          )
        ),
        gym_payment_transactions (
          id,
          payment_mode,
          amount,
          paid_at,
          transaction_reference
        )
      `)
      .eq('member_id', memberId)
      .eq('is_deleted', false)
      .order('created_at', { ascending: false });

    if (paymentsErr) {
      console.error('Error fetching member payments:', paymentsErr);
    }

    // 4. Fetch Active Workout Plan
    const { data: workoutPlans, error: wpErr } = await supabaseAdmin
      .from('gym_workout_plans')
      .select(`
        id,
        title,
        notes,
        status,
        start_date,
        end_date,
        gym_staff (id, full_name),
        gym_workout_plan_items (
          id,
          day_of_week,
          exercise_name,
          muscle_group,
          sets,
          reps,
          weight,
          duration,
          rest_period,
          notes,
          sort_order
        )
      `)
      .eq('member_id', memberId)
      .eq('is_deleted', false)
      .order('created_at', { ascending: false })
      .limit(1);

    if (wpErr) console.error('Error fetching member workout plans:', wpErr);

    let activeWorkoutPlan: any = null;
    if (workoutPlans && workoutPlans.length > 0) {
      const wp = workoutPlans[0];
      activeWorkoutPlan = {
        ...wp,
        name: wp.title,
        description: wp.notes,
        gym_workout_plan_items: (wp.gym_workout_plan_items || []).sort(
          (a: any, b: any) => (a.day_of_week - b.day_of_week) || ((a.sort_order || 0) - (b.sort_order || 0))
        ),
      };
    }

    // 5. Fetch Active Diet Plan
    const { data: dietPlans, error: dpErr } = await supabaseAdmin
      .from('gym_diet_plans')
      .select(`
        id,
        title,
        notes,
        status,
        start_date,
        end_date,
        gym_staff (id, full_name),
        gym_diet_plan_items (
          id,
          day_of_week,
          meal_type,
          food_item,
          quantity,
          calories,
          protein,
          carbs,
          fat,
          notes,
          sort_order
        )
      `)
      .eq('member_id', memberId)
      .eq('is_deleted', false)
      .order('created_at', { ascending: false })
      .limit(1);

    if (dpErr) console.error('Error fetching member diet plans:', dpErr);

    let activeDietPlan: any = null;
    if (dietPlans && dietPlans.length > 0) {
      const dp = dietPlans[0];
      const items = dp.gym_diet_plan_items || [];
      const totalCalories = items.reduce((sum: number, it: any) => sum + (Number(it.calories) || 0), 0);
      const totalProtein = items.reduce((sum: number, it: any) => sum + (Number(it.protein) || 0), 0);
      const totalCarbs = items.reduce((sum: number, it: any) => sum + (Number(it.carbs) || 0), 0);
      const totalFat = items.reduce((sum: number, it: any) => sum + (Number(it.fat) || 0), 0);

      activeDietPlan = {
        ...dp,
        name: dp.title,
        daily_calorie_target: totalCalories,
        totalProtein,
        totalCarbs,
        totalFat,
        gym_diet_plan_items: items.sort(
          (a: any, b: any) => (a.day_of_week - b.day_of_week) || ((a.sort_order || 0) - (b.sort_order || 0))
        ),
      };
    }

    // Calculate days remaining
    let daysRemaining = 0;
    if (member.expiry_date) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const expDate = new Date(member.expiry_date);
      expDate.setHours(0, 0, 0, 0);
      const diffTime = expDate.getTime() - today.getTime();
      daysRemaining = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    }

    res.json({
      member,
      daysRemaining,
      attendance: attendance || [],
      payments: payments || [],
      workoutPlan: activeWorkoutPlan,
      dietPlan: activeDietPlan,
    });
  } catch (error: any) {
    console.error('Member dashboard error:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch dashboard data' });
  }
};

// 5. CHANGE MEMBER PASSWORD
export const changeMemberPassword = async (req: AuthenticatedMemberRequest, res: Response) => {
  try {
    const memberId = req.member?.id;
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current password and new password are required' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters long' });
    }

    const { data: member, error } = await supabaseAdmin
      .from('gym_members')
      .select('id, password_hash')
      .eq('id', memberId)
      .single();

    if (error || !member) {
      return res.status(404).json({ error: 'Member not found' });
    }

    // Verify current password
    if (member.password_hash) {
      const isValid = await bcrypt.compare(currentPassword, member.password_hash);
      if (!isValid) {
        return res.status(401).json({ error: 'Current password is incorrect' });
      }
    }

    // Hash and update new password
    const salt = await bcrypt.genSalt(10);
    const newHash = await bcrypt.hash(newPassword, salt);

    await supabaseAdmin
      .from('gym_members')
      .update({ password_hash: newHash, updated_at: new Date().toISOString() })
      .eq('id', memberId);

    res.json({ message: 'Password updated successfully' });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to change password' });
  }
};
