-- ==============================================================================
-- Migration: Create gym_whatsapp_integrations table for WhatsApp Embedded Signup
-- Supports Meta Cloud API & WhatsApp Business App Coexistence
-- ==============================================================================

CREATE TABLE IF NOT EXISTS public.gym_whatsapp_integrations (
    id SERIAL PRIMARY KEY,
    gym_id INTEGER NOT NULL REFERENCES public.gyms(id) ON DELETE CASCADE,
    waba_id TEXT NOT NULL,
    phone_number_id TEXT NOT NULL,
    display_phone_number TEXT,
    business_name TEXT,
    access_token TEXT NOT NULL, -- Encrypted at rest using AES-256-GCM by backend
    token_expiry TIMESTAMPTZ,
    connection_status TEXT NOT NULL DEFAULT 'connected', -- 'connected', 'disconnected', 'expired', 'error'
    integration_type TEXT NOT NULL DEFAULT 'cloud_api', -- 'business_app_coexistence' or 'cloud_api'
    coexistence_status JSONB DEFAULT '{}'::jsonb,
    raw_metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_gym_whatsapp_integrations_gym UNIQUE (gym_id)
);

-- Indexes for high performance webhook lookups and gym queries
CREATE INDEX IF NOT EXISTS idx_gym_wa_int_gym_id ON public.gym_whatsapp_integrations(gym_id);
CREATE INDEX IF NOT EXISTS idx_gym_wa_int_phone ON public.gym_whatsapp_integrations(phone_number_id);
CREATE INDEX IF NOT EXISTS idx_gym_wa_int_waba ON public.gym_whatsapp_integrations(waba_id);

-- Enable Row Level Security
ALTER TABLE public.gym_whatsapp_integrations ENABLE ROW LEVEL SECURITY;

-- Drop existing policy if present
DROP POLICY IF EXISTS "Gym owners can read own whatsapp integration" ON public.gym_whatsapp_integrations;

-- Row Level Security Policy: Only authenticated gym owners can read their gym's integration record
CREATE POLICY "Gym owners can read own whatsapp integration"
ON public.gym_whatsapp_integrations
FOR SELECT
TO authenticated
USING (
    gym_id IN (
        SELECT id FROM public.gyms WHERE owner_id = auth.uid()
    )
);

