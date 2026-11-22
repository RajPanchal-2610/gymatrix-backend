-- WhatsApp Integration Migration for Gymatrix
-- Supports Meta WhatsApp Cloud API, Quotas per Plan, Monthly/Yearly Addon Packs, Wallets, and Logs

-- 1. Add whatsapp_quota_monthly to public.plans
ALTER TABLE public.plans 
ADD COLUMN IF NOT EXISTS whatsapp_quota_monthly integer DEFAULT 100;

-- Update existing plans with sensible defaults
UPDATE public.plans SET whatsapp_quota_monthly = 50 WHERE id = 1 AND (whatsapp_quota_monthly IS NULL OR whatsapp_quota_monthly = 100);
UPDATE public.plans SET whatsapp_quota_monthly = 500 WHERE id = 2 AND (whatsapp_quota_monthly IS NULL OR whatsapp_quota_monthly = 100);
UPDATE public.plans SET whatsapp_quota_monthly = 2500 WHERE id = 3 AND (whatsapp_quota_monthly IS NULL OR whatsapp_quota_monthly = 100);

-- 2. Create gym_whatsapp_wallets
CREATE TABLE IF NOT EXISTS public.gym_whatsapp_wallets (
  id serial PRIMARY KEY,
  gym_id integer NOT NULL REFERENCES public.gyms(id) ON DELETE CASCADE UNIQUE,
  plan_monthly_quota integer NOT NULL DEFAULT 100,
  plan_quota_used integer NOT NULL DEFAULT 0,
  plan_quota_reset_date timestamp with time zone DEFAULT (now() + interval '1 month'),
  addon_credits_balance integer NOT NULL DEFAULT 0,
  total_messages_sent integer NOT NULL DEFAULT 0,
  is_automated_enabled boolean DEFAULT true,
  custom_phone_number_id text NULL,
  custom_access_token text NULL,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

-- 3. Create whatsapp_addon_packs
CREATE TABLE IF NOT EXISTS public.whatsapp_addon_packs (
  id serial PRIMARY KEY,
  name text NOT NULL,
  message_count integer NOT NULL,
  price numeric(10, 2) NOT NULL,
  duration_value integer NOT NULL DEFAULT 1,
  duration_unit text NOT NULL CHECK (duration_unit IN ('month', 'year')),
  description text NULL,
  is_active boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

-- Seed initial Monthly and Yearly Packs
INSERT INTO public.whatsapp_addon_packs (name, message_count, price, duration_value, duration_unit, description, is_active)
VALUES
  -- Monthly Packs
  ('Starter Boost', 500, 199.00, 1, 'month', '500 WhatsApp Messages valid for 1 month', true),
  ('Pro Growth', 1500, 499.00, 1, 'month', '1,500 WhatsApp Messages valid for 1 month', true),
  ('Power Pack', 5000, 1499.00, 1, 'month', '5,000 WhatsApp Messages valid for 1 month', true),
  -- Yearly Packs
  ('Annual Starter Saver', 6000, 1999.00, 1, 'year', '6,000 WhatsApp Messages valid for 1 full year (~17% discount)', true),
  ('Annual Pro Saver', 18000, 4999.00, 1, 'year', '18,000 WhatsApp Messages valid for 1 full year (~17% discount)', true),
  ('Annual Enterprise Bulk', 60000, 14999.00, 1, 'year', '60,000 WhatsApp Messages valid for 1 full year (~20% discount)', true)
ON CONFLICT DO NOTHING;

-- 4. Create gym_whatsapp_pack_purchases
CREATE TABLE IF NOT EXISTS public.gym_whatsapp_pack_purchases (
  id serial PRIMARY KEY,
  gym_id integer NOT NULL REFERENCES public.gyms(id) ON DELETE CASCADE,
  pack_id integer REFERENCES public.whatsapp_addon_packs(id) ON DELETE SET NULL,
  pack_name text NOT NULL,
  duration_unit text NOT NULL CHECK (duration_unit IN ('month', 'year')),
  messages_credited integer NOT NULL,
  amount_paid numeric(10, 2) NOT NULL,
  razorpay_payment_id text NULL,
  razorpay_order_id text NULL,
  expires_at timestamp with time zone NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamp with time zone DEFAULT now()
);

-- 5. Create whatsapp_logs
CREATE TABLE IF NOT EXISTS public.whatsapp_logs (
  id serial PRIMARY KEY,
  gym_id integer NOT NULL REFERENCES public.gyms(id) ON DELETE CASCADE,
  recipient_phone text NOT NULL,
  recipient_name text NULL,
  event_type text NOT NULL, -- 'welcome', 'membership_expiring', 'payment_reminder', 'custom'
  template_name text NOT NULL,
  meta_message_id text NULL,
  sender_mode text NOT NULL, -- 'meta_cloud_api_central', 'meta_cloud_api_owner', 'owner_mobile_deeplink'
  status text NOT NULL DEFAULT 'sent', -- 'sent', 'delivered', 'read', 'failed', 'deeplink_opened'
  credits_deducted integer DEFAULT 1,
  error_message text NULL,
  created_at timestamp with time zone DEFAULT now()
);

-- 6. Create system_settings for central Super Admin Meta credentials & configurations
CREATE TABLE IF NOT EXISTS public.system_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamp with time zone DEFAULT now()
);

INSERT INTO public.system_settings (key, value)
VALUES (
  'meta_whatsapp',
  jsonb_build_object(
    'is_enabled', true,
    'phone_number_id', '',
    'waba_id', '',
    'access_token', '',
    'webhook_verify_token', 'gymatrix_meta_webhook_secret_2026',
    'default_country_code', '91',
    'templates', jsonb_build_object(
      'welcome', 'gym_member_welcome_v1',
      'membership_expiring', 'gym_membership_expiry_v1',
      'payment_reminder', 'gym_payment_reminder_v1'
    )
  )
)
ON CONFLICT (key) DO NOTHING;

-- 7. Ensure every existing gym has a wallet initialized based on their current subscription plan
INSERT INTO public.gym_whatsapp_wallets (gym_id, plan_monthly_quota)
SELECT 
  g.id,
  COALESCE(p.whatsapp_quota_monthly, 100)
FROM public.gyms g
LEFT JOIN public.subscriptions s ON s.user_id = g.owner_id AND s.status IN ('active', 'Active', 'trial', 'Trial')
LEFT JOIN public.plans p ON p.id = s.plan_id
ON CONFLICT (gym_id) DO NOTHING;
