-- SaaS layer: plans, subscriptions, seat limits, billing events (Razorpay),
-- platform staff and demo requests. Subscription state changes only through
-- apply_billing_event (service role, idempotent) or platform staff RPCs.

insert into public.permissions (key, description) values
  ('billing.manage', 'Manage the subscription and payment details');
update public.roles r set permissions = (select array_agg(key order by key) from public.permissions)
 where r.is_system and r.key = 'owner';

create table public.plans (
  key text primary key check (key ~ '^[a-z][a-z0-9_]{1,30}$'),
  name text not null,
  monthly_inr integer not null check (monthly_inr >= 0),
  yearly_inr integer not null check (yearly_inr >= 0),
  max_users integer not null check (max_users > 0),
  razorpay_plan_monthly text,
  razorpay_plan_yearly text,
  active boolean not null default true,
  sort integer not null default 0
);
-- Placeholder pricing: change in the table (or via platform tools), not in code.
insert into public.plans (key, name, monthly_inr, yearly_inr, max_users, sort) values
  ('starter', 'Starter', 1499, 14990, 3, 1),
  ('growth',  'Growth',  4999, 49990, 15, 2),
  ('scale',   'Scale',   12999, 129990, 100, 3);

create table public.subscriptions (
  tenant_id uuid primary key references public.tenants (id) on delete cascade,
  plan_key text not null references public.plans (key),
  status text not null default 'trialing' check (status in ('trialing', 'active', 'past_due', 'canceled')),
  billing_interval text not null default 'monthly' check (billing_interval in ('monthly', 'yearly')),
  trial_ends_at timestamptz,
  current_period_end timestamptz,
  grace_until timestamptz,
  razorpay_subscription_id text unique,
  updated_at timestamptz not null default now()
);

-- Idempotency + audit of every payment-provider callback.
create table public.billing_events (
  event_id text primary key,
  tenant_id uuid,
  type text not null,
  payload jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now()
);

create table public.platform_staff (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  role text not null check (role in ('owner', 'billing', 'support'))
);

create table public.demo_requests (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 160),
  email text not null check (position('@' in email) > 1 and length(email) <= 200),
  company text,
  message text check (message is null or length(message) <= 2000),
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------------ helpers
create function app.is_platform(allowed text[]) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from platform_staff where user_id = auth.uid() and role = any (allowed))
$$;

create function app.seat_limit(t uuid) returns integer
language sql stable security definer set search_path = public, pg_temp as $$
  select p.max_users from subscriptions s join plans p on p.key = s.plan_key where s.tenant_id = t
$$;

create function app.seats_used(t uuid) returns integer
language sql stable security definer set search_path = public, pg_temp as $$
  select (select count(*) from memberships where tenant_id = t)::int
       + (select count(*) from invitations where tenant_id = t and status = 'pending' and expires_at > now())::int
$$;

-- ----------------------------------------- workspace bootstrap with a trial
create or replace function public.create_workspace(p_name text, p_slug text) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare tid uuid; owner_role uuid; pid uuid; me uuid := app.require_user();
begin
  insert into tenants (name, slug) values (trim(p_name), lower(trim(p_slug))) returning id into tid;
  insert into roles (tenant_id, key, name, permissions, is_system) values
    (tid, 'staff',   'Staff',   array['crm.write'], true),
    (tid, 'manager', 'Manager', array['audit.view', 'crm.read_all', 'crm.write', 'members.invite', 'members.view', 'pipeline.configure'], true);
  insert into roles (tenant_id, key, name, permissions, is_system)
    select tid, 'owner', 'Owner', array_agg(key order by key), true from permissions
    returning id into owner_role;
  insert into memberships (tenant_id, user_id, role_id) values (tid, me, owner_role);
  insert into pipelines (tenant_id, name) values (tid, 'Sales') returning id into pid;
  insert into stages (tenant_id, pipeline_id, name, position, probability, kind) values
    (tid, pid, 'Qualification', 0, 10, 'open'), (tid, pid, 'Proposal', 1, 40, 'open'),
    (tid, pid, 'Negotiation', 2, 70, 'open'), (tid, pid, 'Won', 3, 100, 'won'), (tid, pid, 'Lost', 4, 0, 'lost');
  insert into subscriptions (tenant_id, plan_key, status, trial_ends_at)
    values (tid, 'growth', 'trialing', now() + interval '14 days');
  perform app.log(tid, 'workspace.created', 'tenant', tid::text, jsonb_build_object('slug', lower(trim(p_slug))));
  return tid;
end $$;

insert into public.subscriptions (tenant_id, plan_key, status, trial_ends_at)
  select id, 'growth', 'trialing', now() + interval '14 days' from public.tenants
  where not exists (select 1 from public.subscriptions s where s.tenant_id = tenants.id);

-- Seat limit applies to invitations (an open invitation holds a seat).
create or replace function public.invite_member(p_tenant uuid, p_email text, p_role uuid) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare r roles; mail text := lower(trim(p_email)); tok text; iid uuid;
begin
  perform app.require_perm(p_tenant, 'members.invite');
  select * into r from roles where id = p_role and tenant_id = p_tenant;
  if not found then raise exception 'role_not_found'; end if;
  if not app.holds_all(p_tenant, r.permissions) then raise exception 'cannot_grant_unheld_permission' using errcode = '42501'; end if;
  if exists (select 1 from memberships m join profiles p on p.id = m.user_id where m.tenant_id = p_tenant and p.email = mail) then
    raise exception 'already_a_member';
  end if;
  if exists (select 1 from invitations where tenant_id = p_tenant and email = mail and status = 'pending') then
    raise exception 'already_invited';
  end if;
  if app.seats_used(p_tenant) >= app.seat_limit(p_tenant) then raise exception 'plan_limit_users'; end if;
  tok := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  insert into invitations (tenant_id, email, role_id, token_hash, invited_by, expires_at)
  values (p_tenant, mail, p_role, encode(sha256(convert_to(tok, 'utf8')), 'hex'), auth.uid(), now() + interval '7 days')
  returning id into iid;
  perform app.log(p_tenant, 'invitation.created', 'invitation', iid::text, jsonb_build_object('email', mail, 'role', r.key));
  return tok;
end $$;

-- --------------------------------------------------- payment provider events
-- Called only by the webhook route with the service role, after it has
-- verified the provider's signature. Idempotent on event_id.
create function public.apply_billing_event(
  p_event_id text, p_type text, p_tenant uuid, p_plan text, p_interval text, p_razorpay_sub text, p_period_end timestamptz
) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare fresh boolean;
begin
  insert into billing_events (event_id, tenant_id, type, payload)
  values (p_event_id, p_tenant, p_type, jsonb_build_object('plan', p_plan, 'interval', p_interval, 'sub', p_razorpay_sub, 'period_end', p_period_end))
  on conflict (event_id) do nothing;
  get diagnostics fresh = row_count;
  if not fresh then return false; end if;
  if not exists (select 1 from subscriptions where tenant_id = p_tenant) then return true; end if;  -- unknown tenant: recorded, ignored
  if p_type in ('subscription.activated', 'subscription.charged', 'subscription.resumed') then
    update subscriptions set status = 'active', plan_key = coalesce((select key from plans where key = p_plan), plan_key),
           billing_interval = coalesce(p_interval, billing_interval), razorpay_subscription_id = coalesce(p_razorpay_sub, razorpay_subscription_id),
           current_period_end = p_period_end, grace_until = null, updated_at = now()
     where tenant_id = p_tenant;
    update tenants set status = 'active' where id = p_tenant;
  elsif p_type in ('subscription.pending', 'subscription.halted') then
    update subscriptions set status = 'past_due', grace_until = coalesce(grace_until, now() + interval '7 days'), updated_at = now() where tenant_id = p_tenant;
  elsif p_type in ('subscription.cancelled', 'subscription.completed') then
    update subscriptions set status = 'canceled', updated_at = now() where tenant_id = p_tenant;
  end if;
  perform app.log(p_tenant, 'billing.' || p_type, 'subscription', p_tenant::text, jsonb_build_object('plan', p_plan));
  return true;
end $$;

-- ------------------------------------------------------------- platform staff
create function public.platform_overview() returns table (
  tenant_id uuid, name text, slug text, tenant_status text, plan_key text, sub_status text,
  trial_ends_at timestamptz, users int, created_at timestamptz)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not app.is_platform(array['owner', 'billing', 'support']) then raise exception 'forbidden' using errcode = '42501'; end if;
  return query
    select t.id, t.name, t.slug, t.status, s.plan_key, s.status, s.trial_ends_at,
           (select count(*)::int from memberships m where m.tenant_id = t.id), t.created_at
      from tenants t left join subscriptions s on s.tenant_id = t.id order by t.created_at desc;
end $$;

create function public.platform_set_tenant_status(p_tenant uuid, p_status text, p_reason text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not app.is_platform(array['owner', 'support']) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_status not in ('trial', 'active', 'suspended') then raise exception 'invalid_status'; end if;
  if length(trim(coalesce(p_reason, ''))) = 0 then raise exception 'reason_required'; end if;
  update tenants set status = p_status where id = p_tenant;
  if not found then raise exception 'workspace_not_found'; end if;
  perform app.log(p_tenant, 'platform.status_changed', 'tenant', p_tenant::text, jsonb_build_object('status', p_status, 'reason', trim(p_reason)));
end $$;

create function public.platform_set_plan(p_tenant uuid, p_plan text, p_reason text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not app.is_platform(array['owner', 'billing']) then raise exception 'forbidden' using errcode = '42501'; end if;
  if length(trim(coalesce(p_reason, ''))) = 0 then raise exception 'reason_required'; end if;
  update subscriptions set plan_key = p_plan, updated_at = now() where tenant_id = p_tenant;
  if not found then raise exception 'workspace_not_found'; end if;
  perform app.log(p_tenant, 'platform.plan_changed', 'subscription', p_tenant::text, jsonb_build_object('plan', p_plan, 'reason', trim(p_reason)));
end $$;

-- Suspends workspaces whose trial or payment grace period has run out.
create function public.platform_expire_subscriptions() returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare n int; r record;
begin
  if not app.is_platform(array['owner', 'billing']) then raise exception 'forbidden' using errcode = '42501'; end if;
  n := 0;
  for r in select s.tenant_id from subscriptions s join tenants t on t.id = s.tenant_id
            where t.status <> 'suspended' and (
              (s.status = 'trialing' and s.trial_ends_at < now()) or
              (s.status = 'past_due' and s.grace_until < now()) or s.status = 'canceled' and coalesce(s.current_period_end, now()) < now())
  loop
    update tenants set status = 'suspended' where id = r.tenant_id;
    perform app.log(r.tenant_id, 'platform.expired', 'tenant', r.tenant_id::text);
    n := n + 1;
  end loop;
  return n;
end $$;

create function public.platform_demo_requests() returns setof public.demo_requests
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not app.is_platform(array['owner', 'support']) then raise exception 'forbidden' using errcode = '42501'; end if;
  return query select * from demo_requests order by created_at desc limit 200;
end $$;

create function public.submit_demo_request(p_name text, p_email text, p_company text, p_message text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if length(trim(coalesce(p_name, ''))) = 0 or position('@' in coalesce(p_email, '')) < 2 then raise exception 'invalid_request'; end if;
  insert into demo_requests (name, email, company, message)
  values (trim(p_name), lower(trim(p_email)), nullif(trim(coalesce(p_company, '')), ''), nullif(trim(coalesce(p_message, '')), ''));
end $$;

-- ------------------------------------------------------------ grants and RLS
revoke all on public.plans, public.subscriptions, public.billing_events, public.platform_staff, public.demo_requests from anon, authenticated;
revoke execute on function app.is_platform(text[]), app.seat_limit(uuid), app.seats_used(uuid) from public, anon;
revoke execute on function public.apply_billing_event(text, text, uuid, text, text, text, timestamptz) from public, anon, authenticated;
revoke execute on function public.platform_overview(), public.platform_set_tenant_status(uuid, text, text), public.platform_set_plan(uuid, text, text),
  public.platform_expire_subscriptions(), public.platform_demo_requests(), public.submit_demo_request(text, text, text, text) from public, anon;
revoke execute on function public.create_workspace(text, text), public.invite_member(uuid, text, uuid) from public, anon;

grant execute on function public.apply_billing_event(text, text, uuid, text, text, text, timestamptz) to service_role;
grant execute on function app.seat_limit(uuid), app.seats_used(uuid), app.is_platform(text[]) to authenticated;
grant execute on function public.platform_overview(), public.platform_set_tenant_status(uuid, text, text), public.platform_set_plan(uuid, text, text),
  public.platform_expire_subscriptions(), public.platform_demo_requests() to authenticated;
grant execute on function public.submit_demo_request(text, text, text, text) to anon, authenticated;
grant execute on function public.create_workspace(text, text), public.invite_member(uuid, text, uuid) to authenticated;

alter table public.plans enable row level security;
alter table public.subscriptions enable row level security;
alter table public.billing_events enable row level security;
alter table public.platform_staff enable row level security;
alter table public.demo_requests enable row level security;

grant select on public.plans to anon, authenticated;
grant select on public.subscriptions to authenticated;
create policy plans_read on public.plans for select to anon, authenticated using (active);
create policy subscriptions_read on public.subscriptions for select to authenticated using (app.is_member(tenant_id));
-- billing_events, platform_staff, demo_requests: no client policies and no grants = service role / RPC only.
