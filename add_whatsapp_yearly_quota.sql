-- Add yearly WhatsApp quota column to plans
ALTER TABLE public.plans 
ADD COLUMN IF NOT EXISTS whatsapp_quota_yearly integer DEFAULT 1200;

-- Update existing plans to have yearly quota = 12 * monthly quota
UPDATE public.plans
SET whatsapp_quota_yearly = COALESCE(whatsapp_quota_monthly * 12, 1200);

-- Set specific known defaults for starter/pro/enterprise
UPDATE public.plans
SET whatsapp_quota_yearly = 600
WHERE LOWER(name) LIKE '%starter%' OR LOWER(name) LIKE '%basic%';

UPDATE public.plans
SET whatsapp_quota_yearly = 6000
WHERE LOWER(name) LIKE '%pro%' OR LOWER(name) LIKE '%standard%';

UPDATE public.plans
SET whatsapp_quota_yearly = 30000
WHERE LOWER(name) LIKE '%enterprise%' OR LOWER(name) LIKE '%premium%';
