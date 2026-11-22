-- Migration to add authentication columns to gym_members table
ALTER TABLE public.gym_members 
ADD COLUMN IF NOT EXISTS password_hash TEXT,
ADD COLUMN IF NOT EXISTS last_login TIMESTAMPTZ;

-- Add index on phone for fast lookup during login/registration
CREATE INDEX IF NOT EXISTS idx_gym_members_phone ON public.gym_members(phone);

