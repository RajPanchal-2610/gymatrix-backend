-- Add reminder scheduling options to gym_whatsapp_wallets
ALTER TABLE public.gym_whatsapp_wallets 
ADD COLUMN IF NOT EXISTS expiry_reminder_days integer[] DEFAULT ARRAY[3, 0],
ADD COLUMN IF NOT EXISTS expiry_followup_interval integer DEFAULT 7,
ADD COLUMN IF NOT EXISTS payment_reminder_days integer[] DEFAULT ARRAY[1, 0],
ADD COLUMN IF NOT EXISTS payment_followup_interval integer DEFAULT 7;

-- Update any existing rows to have default values if null
UPDATE public.gym_whatsapp_wallets
SET 
  expiry_reminder_days = COALESCE(expiry_reminder_days, ARRAY[3, 0]),
  expiry_followup_interval = COALESCE(expiry_followup_interval, 7),
  payment_reminder_days = COALESCE(payment_reminder_days, ARRAY[1, 0]),
  payment_followup_interval = COALESCE(payment_followup_interval, 7);
