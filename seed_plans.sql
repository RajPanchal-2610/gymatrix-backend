-- Seed data for Subscription Plans, Prices, and Feature Mappings

-- 1. Insert Plans
INSERT INTO public.plans (id, name, description, max_gyms, max_members, is_active) VALUES
  (1, 'Starter', 'Basic management for small or new gyms', 1, 50, true),
  (2, 'Professional', 'Advanced tools for growing fitness centers', 3, 500, true),
  (3, 'Elite Enterprise', 'Unlimited power for high-volume gym networks', 10, 5000, true)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  max_gyms = EXCLUDED.max_gyms,
  max_members = EXCLUDED.max_members,
  is_active = EXCLUDED.is_active;

-- 2. Insert Plan Prices (Monthly and Yearly)
INSERT INTO public.plan_prices (plan_id, price, duration_value, duration_unit, is_active) VALUES
  -- Starter (Free)
  (1, 0, 1, 'month', true),
  (1, 0, 1, 'year', true),
  
  -- Professional
  (2, 2999, 1, 'month', true),
  (2, 29990, 1, 'year', true),
  
  -- Elite Enterprise
  (3, 9999, 1, 'month', true),
  (3, 99990, 1, 'year', true)
ON CONFLICT (plan_id, duration_value, duration_unit) DO UPDATE SET
  price = EXCLUDED.price,
  is_active = EXCLUDED.is_active;

-- 3. Map Features to Plans (plan_features)
-- Starter Features: Dashboard (2), Members (3), Memberships (4)
INSERT INTO public.plan_features (plan_id, feature_id, value) VALUES
  (1, 2, 'true'), (1, 3, 'true'), (1, 4, 'true')
ON CONFLICT (plan_id, feature_id) DO UPDATE SET value = 'true';

-- Professional Features: Starter + Finance (5), Inventory (6), Reports (9), Settings (10)
INSERT INTO public.plan_features (plan_id, feature_id, value) VALUES
  (2, 2, 'true'), (2, 3, 'true'), (2, 4, 'true'), 
  (2, 5, 'true'), (2, 6, 'true'), (2, 9, 'true'), (2, 10, 'true')
ON CONFLICT (plan_id, feature_id) DO UPDATE SET value = 'true';

-- Elite Features: ALL (1-10)
INSERT INTO public.plan_features (plan_id, feature_id, value) VALUES
  (3, 1, 'true'), (3, 2, 'true'), (3, 3, 'true'), (3, 4, 'true'), (3, 5, 'true'),
  (3, 6, 'true'), (3, 7, 'true'), (3, 8, 'true'), (3, 9, 'true'), (3, 10, 'true')
ON CONFLICT (plan_id, feature_id) DO UPDATE SET value = 'true';
