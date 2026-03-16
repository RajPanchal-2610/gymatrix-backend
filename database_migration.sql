-- 1. Create permissions table
CREATE TABLE public.permissions (
  id serial primary key,
  action text not null unique,
  description text null,
  module text not null,
  created_at timestamp default now()
);

-- 2. Modify gym_roles
ALTER TABLE public.gym_roles
  ADD COLUMN gym_id integer null references public.gyms(id) ON DELETE CASCADE,
  DROP CONSTRAINT IF EXISTS gym_roles_name_unique,
  ADD CONSTRAINT gym_roles_name_gym_id_unique UNIQUE NULLS NOT DISTINCT (name, gym_id);

-- 3. Create role_permissions
CREATE TABLE public.role_permissions (
  id serial primary key,
  role_id integer not null references public.gym_roles(id) ON DELETE CASCADE,
  permission_id integer not null references public.permissions(id) ON DELETE CASCADE,
  created_at timestamp default now(),
  CONSTRAINT role_permissions_role_perm_unique UNIQUE (role_id, permission_id)
);

-- 4. Insert Seed Permissions
INSERT INTO public.permissions (action, module, description) VALUES
  ('manage_staff', 'Staff', 'Can add, edit, or remove staff members'),
  ('view_staff', 'Staff', 'Can view the staff list'),
  ('manage_members', 'Members', 'Can add, edit, or remove gym members'),
  ('view_members', 'Members', 'Can view the member list'),
  ('view_financials', 'Financials', 'Can view revenue and payment stats'),
  ('manage_roles', 'Settings', 'Can create and edit gym roles')
ON CONFLICT (action) DO NOTHING;
