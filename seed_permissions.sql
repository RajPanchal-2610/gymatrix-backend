-- Seed data for permissions mapped to their respective features
INSERT INTO public.permissions (action, feature_id, description) VALUES
  -- Dashboard (Feature 2)
  ('view_dashboard_stats', 2, 'Can access the main dashboard overview'),
  ('view_activity_logs', 2, 'Can view the recent activity feed on the dashboard'),
  
  -- Members (Feature 3)
  ('view_members', 3, 'Can view the list of gym members'),
  ('add_members', 3, 'Can register new gym members'),
  ('edit_members', 3, 'Can modify member profiles and details'),
  ('delete_members', 3, 'Can delete or archive member records'),
  ('view_membership_history', 3, 'Can view member renewal and subscription history'),
  ('renew_membership', 3, 'Can process membership renewals for members'),
  ('view_attendance', 3, 'Can view member check-in/check-out records'),
  ('manage_attendance', 3, 'Can manually mark or correct member attendance'),

  -- Membership Plans (Feature 4)
  ('view_membership_plans', 4, 'Can view available membership plans and pricing'),
  ('add_membership_plans', 4, 'Can create new membership plans'),
  ('edit_membership_plans', 4, 'Can update existing membership plan details'),
  ('delete_membership_plans', 4, 'Can remove membership plans'),

  -- Payments & Billing (Feature 5)
  ('view_payments', 5, 'Can view all payment transactions and invoices'),
  ('manage_payments', 5, 'Can record payments and generate invoices for members'),
  ('view_revenue_summary', 5, 'Can view detailed revenue charts and financial summaries'),

  -- Inventory (Feature 6)
  ('view_inventory', 6, 'Can access the inventory management dashboard'),
  ('add_inventory', 6, 'Can add new equipment, stock, or maintenance logs'),
  ('edit_inventory', 6, 'Can update equipment details and stock levels'),
  ('delete_inventory', 6, 'Can remove items from inventory or delete transaction history'),

  -- Staff & HR (Feature 7)
  ('view_staff', 7, 'Can view the list of gym staff and employees'),
  ('add_staff', 7, 'Can onboard new staff members'),
  ('edit_staff', 7, 'Can update staff profile information and roles'),
  ('delete_staff', 7, 'Can remove staff members from the system'),
  ('view_staff_attendance', 7, 'Can view daily attendance logs for staff'),
  ('manage_staff_attendance', 7, 'Can mark staff as present/absent or edit logs'),
  ('view_payroll', 7, 'Can view staff salary and payroll information'),
  ('manage_payroll', 7, 'Can process monthly payroll and update salary details'),

  -- Access Control (Feature 8)
  ('view_roles', 8, 'Can view the list of system roles'),
  ('add_roles', 8, 'Can create new custom roles for the gym'),
  ('edit_roles', 8, 'Can modify role names and associated permissions'),
  ('delete_roles', 8, 'Can delete custom roles'),
  ('view_permissions', 8, 'Can see the master list of system-wide permissions'),
  ('manage_permissions', 8, 'Can create or edit the system permission actions'),

  -- Reports (Feature 9)
  ('view_reports', 9, 'Can view and export all business and performance reports'),

  -- Settings (Feature 10)
  ('view_gym_settings', 10, 'Can access the gym profile and general settings'),
  ('edit_gym_settings', 10, 'Can update gym name, contact info, and branding')
ON CONFLICT (action) DO UPDATE SET 
  feature_id = EXCLUDED.feature_id,
  description = EXCLUDED.description;
