-- Phase 1 foundation: workspaces (tenants), people, memberships, roles,
-- invitations and the audit trail.
-- Every tenant-owned table carries tenant_id. All writes go through the RPC
-- functions in 20261105000200; clients only get SELECT (see 000300).

create schema if not exists app;

create table public.permissions (
  key text primary key,
  description text not null
);
insert into public.permissions (key, description) values
  ('members.view',     'View the member directory'),
  ('members.invite',   'Invite people and revoke invitations'),
  ('members.manage',   'Change roles, suspend, reinstate and remove members'),
  ('roles.manage',     'Create, edit and delete roles'),
  ('audit.view',       'Read the audit trail'),
  ('tenant.configure', 'Change workspace settings');

create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 2 and 80),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  status text not null default 'trial' check (status in ('trial', 'active', 'suspended')),
  created_at timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null check (email = lower(email)),
  full_name text not null default '',
  created_at timestamptz not null default now()
);

create table public.roles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  key text not null check (key ~ '^[a-z][a-z0-9_]{1,30}$'),
  name text not null check (length(trim(name)) between 2 and 60),
  permissions text[] not null default '{}',
  is_system boolean not null default false,
  created_at timestamptz not null default now(),
  unique (tenant_id, key),
  unique (tenant_id, id)  -- target of the composite foreign keys below
);

-- Composite FKs make it impossible to attach a role from another tenant.
create table public.memberships (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role_id uuid not null,
  status text not null default 'active' check (status in ('active', 'suspended')),
  created_at timestamptz not null default now(),
  unique (tenant_id, user_id),
  foreign key (tenant_id, role_id) references public.roles (tenant_id, id)
);
create index memberships_user_idx on public.memberships (user_id);

create table public.invitations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  email text not null check (email = lower(email) and position('@' in email) > 1),
  role_id uuid not null,
  token_hash text not null unique,  -- sha256 of the emailed token; the token itself is never stored
  status text not null default 'pending' check (status in ('pending', 'accepted', 'revoked')),
  invited_by uuid references public.profiles (id) on delete set null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  foreign key (tenant_id, role_id) references public.roles (tenant_id, id)
);
create unique index invitations_one_pending on public.invitations (tenant_id, email) where status = 'pending';

-- Append-only. No FK on tenant_id so history outlives anything else.
create table public.audit_log (
  id bigint generated always as identity primary key,
  tenant_id uuid not null,
  actor_id uuid,
  action text not null,
  entity text not null,
  entity_id text,
  detail jsonb not null default '{}'::jsonb,
  at timestamptz not null default now()
);
create index audit_log_tenant_at_idx on public.audit_log (tenant_id, at desc);

create function app.audit_log_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'audit_log is append-only';
end $$;
create trigger audit_log_no_update before update or delete on public.audit_log
  for each row execute function app.audit_log_immutable();
create trigger audit_log_no_truncate before truncate on public.audit_log
  for each statement execute function app.audit_log_immutable();

-- A profile row appears for every new auth user.
create function app.handle_new_user() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, lower(new.email), coalesce(new.raw_user_meta_data ->> 'full_name', ''));
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function app.handle_new_user();
