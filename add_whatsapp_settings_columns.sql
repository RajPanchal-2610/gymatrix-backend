-- Add notification preference columns to gym_whatsapp_wallets (defaults to false / disabled)
ALTER TABLE public.gym_whatsapp_wallets 
ADD COLUMN IF NOT EXISTS is_automated_enabled boolean DEFAULT false,
ADD COLUMN IF NOT EXISTS send_welcome_message boolean DEFAULT false,
ADD COLUMN IF NOT EXISTS send_expiry_alert boolean DEFAULT false,
ADD COLUMN IF NOT EXISTS send_payment_reminder boolean DEFAULT false;

-- Update defaults if columns already existed
ALTER TABLE public.gym_whatsapp_wallets ALTER COLUMN is_automated_enabled SET DEFAULT false;
ALTER TABLE public.gym_whatsapp_wallets ALTER COLUMN send_welcome_message SET DEFAULT false;
ALTER TABLE public.gym_whatsapp_wallets ALTER COLUMN send_expiry_alert SET DEFAULT false;
ALTER TABLE public.gym_whatsapp_wallets ALTER COLUMN send_payment_reminder SET DEFAULT false;
