-- Phase 2/3 core CRM: accounts, contacts, leads, pipelines, opportunities,
-- activities. Isolation rules:
--  * every row carries tenant_id; cross-table links are composite foreign keys
--    on (tenant_id, id), so a row can never point into another tenant;
--  * tenant_id is immutable; owners must be active members of the tenant;
--  * visibility = crm.read_all (whole tenant) or ownership (own records only);
--  * nothing is ever deleted by clients: records are archived.

insert into public.permissions (key, description) values
  ('crm.read_all',       'See every account, contact, lead and opportunity in the workspace'),
  ('crm.write',          'Create and edit records you own'),
  ('pipeline.configure', 'Configure pipelines and stages'),
  ('crm.export',         'Export records');

-- System roles: Staff work their own records; Manager sees everything.
update public.roles set permissions = array['crm.write'] where is_system and key = 'staff';
update public.roles set permissions = array['audit.view', 'crm.read_all', 'crm.write', 'members.invite', 'members.view', 'pipeline.configure']
  where is_system and key = 'manager';
update public.roles r set permissions = (select array_agg(key order by key) from public.permissions) where r.is_system and r.key = 'owner';

-- ------------------------------------------------------------------ helpers
create function app.can_read_record(t uuid, owner uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select app.has_perm(t, 'crm.read_all') or (owner is not null and owner = auth.uid() and app.has_perm(t, 'crm.write'))
$$;

create function app.can_write_record(t uuid, owner uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select app.has_perm(t, 'crm.write') and (app.has_perm(t, 'crm.read_all') or owner = auth.uid())
$$;

create function app.lock_tenant_id() returns trigger language plpgsql as $$
begin
  if new.tenant_id <> old.tenant_id then raise exception 'tenant_id is immutable'; end if;
  return new;
end $$;

create function app.check_owner() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.owner_id is not null and (tg_op = 'INSERT' or new.owner_id is distinct from old.owner_id)
     and not exists (select 1 from memberships where tenant_id = new.tenant_id and user_id = new.owner_id and status = 'active') then
    raise exception 'owner_not_member';
  end if;
  return new;
end $$;

-- ----------------------------------------------------------------- accounts
create table public.accounts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 160),
  domain text check (domain is null or domain = lower(domain)),
  industry text,
  source text not null default 'manual' check (source in ('manual', 'import', 'lead', 'web', 'referral', 'enrichment')),
  owner_id uuid default auth.uid(),
  created_by uuid default auth.uid(),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, id)
);
create unique index accounts_name_unique on public.accounts (tenant_id, lower(name)) where archived_at is null;

create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  account_id uuid,
  full_name text not null check (length(trim(full_name)) between 1 and 160),
  email text check (email is null or (email = lower(email) and position('@' in email) > 1)),
  phone text,
  job_title text,
  source text not null default 'manual' check (source in ('manual', 'import', 'lead', 'web', 'referral', 'enrichment')),
  opted_out boolean not null default false,  -- outreach suppression (Phase 5 reads this)
  owner_id uuid default auth.uid(),
  created_by uuid default auth.uid(),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, account_id) references public.accounts (tenant_id, id)
);
create unique index contacts_email_unique on public.contacts (tenant_id, email) where email is not null and archived_at is null;
create index contacts_account_idx on public.contacts (tenant_id, account_id);

-- ---------------------------------------------------------------- pipelines
create table public.pipelines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 80),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, name)
);
create table public.stages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  pipeline_id uuid not null,
  name text not null check (length(trim(name)) between 1 and 60),
  position int not null check (position >= 0),
  probability int not null check (probability between 0 and 100),
  kind text not null default 'open' check (kind in ('open', 'won', 'lost')),
  unique (tenant_id, id),
  unique (tenant_id, pipeline_id, id),
  unique (pipeline_id, position) deferrable initially deferred,
  foreign key (tenant_id, pipeline_id) references public.pipelines (tenant_id, id) on delete cascade,
  check ((kind = 'won' and probability = 100) or (kind = 'lost' and probability = 0) or kind = 'open')
);

-- ------------------------------------------------------------ opportunities
create table public.opportunities (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 160),
  account_id uuid,
  contact_id uuid,
  pipeline_id uuid not null,
  stage_id uuid not null,
  amount numeric(14, 2) not null default 0 check (amount >= 0),
  currency text not null default 'INR' check (currency ~ '^[A-Z]{3}$'),
  expected_close date,
  status text not null default 'open' check (status in ('open', 'won', 'lost')),
  loss_reason text,
  next_action text,
  next_action_due date,
  owner_id uuid default auth.uid(),
  created_by uuid default auth.uid(),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, account_id) references public.accounts (tenant_id, id),
  foreign key (tenant_id, contact_id) references public.contacts (tenant_id, id),
  foreign key (tenant_id, pipeline_id, stage_id) references public.stages (tenant_id, pipeline_id, id),
  check (status <> 'lost' or length(trim(coalesce(loss_reason, ''))) > 0)
);
create index opportunities_stage_idx on public.opportunities (tenant_id, stage_id);

-- Status follows the stage kind; losing needs a reason; reopening clears it.
create function app.opportunity_stage_rules() returns trigger language plpgsql as $$
declare k text;
begin
  select kind into k from stages where id = new.stage_id;
  new.status := case k when 'won' then 'won' when 'lost' then 'lost' else 'open' end;
  if new.status = 'lost' and length(trim(coalesce(new.loss_reason, ''))) = 0 then raise exception 'loss_reason_required'; end if;
  if new.status <> 'lost' then new.loss_reason := null; end if;
  return new;
end $$;
create trigger opportunity_stage_rules before insert or update on public.opportunities
  for each row execute function app.opportunity_stage_rules();

-- History cannot be bypassed: it is written by trigger and is append-only.
create table public.opportunity_history (
  id bigint generated always as identity primary key,
  tenant_id uuid not null,
  opportunity_id uuid not null,
  actor_id uuid,
  event text not null,
  from_stage_id uuid, to_stage_id uuid,
  from_amount numeric(14, 2), to_amount numeric(14, 2),
  from_owner uuid, to_owner uuid,
  reason text,
  at timestamptz not null default now()
);
create index opportunity_history_idx on public.opportunity_history (tenant_id, opportunity_id, id);
create trigger opportunity_history_immutable before update or delete on public.opportunity_history
  for each row execute function app.audit_log_immutable();

create function app.opportunity_history() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    insert into opportunity_history (tenant_id, opportunity_id, actor_id, event, to_stage_id, to_amount, to_owner)
    values (new.tenant_id, new.id, auth.uid(), 'created', new.stage_id, new.amount, new.owner_id);
  else
    if new.stage_id <> old.stage_id then
      insert into opportunity_history (tenant_id, opportunity_id, actor_id, event, from_stage_id, to_stage_id, reason)
      values (new.tenant_id, new.id, auth.uid(),
        case when new.status = 'open' and old.status <> 'open' then 'reopened' else 'stage_changed' end,
        old.stage_id, new.stage_id, new.loss_reason);
    end if;
    if new.amount <> old.amount then
      insert into opportunity_history (tenant_id, opportunity_id, actor_id, event, from_amount, to_amount)
      values (new.tenant_id, new.id, auth.uid(), 'amount_changed', old.amount, new.amount);
    end if;
    if new.owner_id is distinct from old.owner_id then
      insert into opportunity_history (tenant_id, opportunity_id, actor_id, event, from_owner, to_owner)
      values (new.tenant_id, new.id, auth.uid(), 'owner_changed', old.owner_id, new.owner_id);
    end if;
  end if;
  return new;
end $$;
create trigger opportunity_history after insert or update on public.opportunities
  for each row execute function app.opportunity_history();

-- -------------------------------------------------------------------- leads
create table public.leads (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 160),
  email text check (email is null or (email = lower(email) and position('@' in email) > 1)),
  phone text,
  company text,
  message text check (message is null or length(message) <= 2000),
  source text not null default 'manual' check (source in ('manual', 'import', 'web', 'referral')),
  status text not null default 'new' check (status in ('new', 'qualified', 'disqualified', 'converted')),
  score int not null default 0 check (score between 0 and 100),
  score_reasons jsonb not null default '[]'::jsonb,
  owner_id uuid,  -- null = unassigned queue
  disqualify_reason text,
  can_return boolean not null default false,
  converted_opportunity_id uuid,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, converted_opportunity_id) references public.opportunities (tenant_id, id),
  check (status <> 'disqualified' or length(trim(coalesce(disqualify_reason, ''))) > 0)
);
create unique index leads_email_open on public.leads (tenant_id, email) where email is not null and status in ('new', 'qualified');

-- Bounded, explainable score: every point has a stated reason.
create function app.score_lead() returns trigger language plpgsql as $$
declare s int := 0; r jsonb := '[]'::jsonb; dom text;
begin
  dom := split_part(coalesce(new.email, ''), '@', 2);
  if dom <> '' and dom not in ('gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com', 'proton.me', 'rediffmail.com') then
    s := s + 30; r := r || jsonb_build_object('points', 30, 'reason', 'Business email domain');
  end if;
  if length(trim(coalesce(new.company, ''))) > 0 then s := s + 20; r := r || jsonb_build_object('points', 20, 'reason', 'Company provided'); end if;
  if length(trim(coalesce(new.phone, ''))) > 0 then s := s + 10; r := r || jsonb_build_object('points', 10, 'reason', 'Phone provided'); end if;
  if length(trim(coalesce(new.message, ''))) > 0 then s := s + 10; r := r || jsonb_build_object('points', 10, 'reason', 'Wrote a message'); end if;
  if new.source = 'referral' then s := s + 30; r := r || jsonb_build_object('points', 30, 'reason', 'Referral'); end if;
  new.score := least(s, 100);
  new.score_reasons := r;
  return new;
end $$;
create trigger score_lead before insert or update of email, company, phone, message, source on public.leads
  for each row execute function app.score_lead();

-- --------------------------------------------------------------- activities
create table public.activities (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  kind text not null default 'task' check (kind in ('task', 'call', 'meeting', 'note', 'email')),
  subject text not null check (length(trim(subject)) between 1 and 200),
  body text check (body is null or length(body) <= 5000),
  outcome text,
  due_at timestamptz,
  done_at timestamptz,
  account_id uuid, contact_id uuid, opportunity_id uuid,
  owner_id uuid default auth.uid(),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  foreign key (tenant_id, account_id) references public.accounts (tenant_id, id),
  foreign key (tenant_id, contact_id) references public.contacts (tenant_id, id),
  foreign key (tenant_id, opportunity_id) references public.opportunities (tenant_id, id)
);
create index activities_owner_due on public.activities (tenant_id, owner_id, due_at) where done_at is null;

-- Shared triggers.
do $$ declare t text; begin
  foreach t in array array['accounts', 'contacts', 'opportunities', 'leads', 'activities', 'pipelines', 'stages'] loop
    execute format('create trigger lock_tenant before update on public.%I for each row execute function app.lock_tenant_id()', t);
  end loop;
  foreach t in array array['accounts', 'contacts', 'opportunities', 'leads', 'activities'] loop
    execute format('create trigger check_owner before insert or update on public.%I for each row execute function app.check_owner()', t);
  end loop;
end $$;

-- ------------------------------------------------------ workspace bootstrap
-- Replaces the Phase 1 version: new role sets, plus a default pipeline.
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
  perform app.log(tid, 'workspace.created', 'tenant', tid::text, jsonb_build_object('slug', lower(trim(p_slug))));
  return tid;
end $$;

-- Give workspaces created before this migration the default pipeline too.
do $$ declare t record; pid uuid; begin
  for t in select id from tenants where not exists (select 1 from pipelines p where p.tenant_id = tenants.id) loop
    insert into pipelines (tenant_id, name) values (t.id, 'Sales') returning id into pid;
    insert into stages (tenant_id, pipeline_id, name, position, probability, kind) values
      (t.id, pid, 'Qualification', 0, 10, 'open'), (t.id, pid, 'Proposal', 1, 40, 'open'),
      (t.id, pid, 'Negotiation', 2, 70, 'open'), (t.id, pid, 'Won', 3, 100, 'won'), (t.id, pid, 'Lost', 4, 0, 'lost');
  end loop;
end $$;

-- ------------------------------------------------------------------- leads
-- Public web form. The only thing anonymous callers can do; it validates,
-- dedupes and assigns round-robin to the active writer with the fewest open leads.
create function public.capture_lead(p_slug text, p_name text, p_email text, p_company text, p_phone text, p_message text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare t tenants; mail text := nullif(lower(trim(coalesce(p_email, ''))), ''); who uuid;
begin
  select * into t from tenants where slug = lower(trim(p_slug)) and status <> 'suspended';
  if not found then return; end if;  -- silent: do not reveal which workspaces exist
  if length(trim(coalesce(p_name, ''))) = 0 or length(p_name) > 160 or length(coalesce(p_message, '')) > 2000
     or (mail is not null and (position('@' in mail) < 2 or length(mail) > 200)) then
    raise exception 'invalid_lead';
  end if;
  select m.user_id into who
    from memberships m join roles r on r.id = m.role_id
   where m.tenant_id = t.id and m.status = 'active' and 'crm.write' = any (r.permissions)
   order by (select count(*) from leads l where l.tenant_id = t.id and l.owner_id = m.user_id and l.status in ('new', 'qualified')), m.created_at
   limit 1;
  insert into leads (tenant_id, name, email, company, phone, message, source, owner_id, created_by)
  values (t.id, trim(p_name), mail, nullif(trim(coalesce(p_company, '')), ''), nullif(trim(coalesce(p_phone, '')), ''),
          nullif(trim(coalesce(p_message, '')), ''), 'web', who, null)
  on conflict (tenant_id, email) where email is not null and status in ('new', 'qualified')
  do update set message = coalesce(nullif(trim(coalesce(excluded.message, '')), ''), leads.message);
end $$;

-- Conversion links or creates contact + account and creates the opportunity.
-- SECURITY INVOKER: it can only do what the caller's own RLS permits.
create function public.convert_lead(p_lead uuid, p_amount numeric default 0) returns uuid
language plpgsql set search_path = public, pg_temp as $$
declare l leads; aid uuid; cid uuid; oid uuid; pid uuid; sid uuid;
begin
  select * into l from leads where id = p_lead for update;
  if not found then raise exception 'lead_not_found'; end if;
  if l.status = 'converted' then raise exception 'lead_already_converted'; end if;
  if l.status = 'disqualified' then raise exception 'lead_disqualified'; end if;
  if l.company is not null then
    select id into aid from accounts where tenant_id = l.tenant_id and lower(name) = lower(l.company) and archived_at is null;
    if aid is null then
      insert into accounts (tenant_id, name, source, owner_id) values (l.tenant_id, l.company, 'lead', auth.uid()) returning id into aid;
    end if;
  end if;
  if l.email is not null then
    select id into cid from contacts where tenant_id = l.tenant_id and email = l.email and archived_at is null;
  end if;
  if cid is null then
    insert into contacts (tenant_id, account_id, full_name, email, phone, source, owner_id)
    values (l.tenant_id, aid, l.name, l.email, l.phone, 'lead', auth.uid()) returning id into cid;
  end if;
  select id into pid from pipelines where tenant_id = l.tenant_id order by created_at limit 1;
  select id into sid from stages where pipeline_id = pid and kind = 'open' order by position limit 1;
  insert into opportunities (tenant_id, name, account_id, contact_id, pipeline_id, stage_id, amount, owner_id)
  values (l.tenant_id, coalesce(l.company, l.name), aid, cid, pid, sid, coalesce(p_amount, 0), auth.uid()) returning id into oid;
  update leads set status = 'converted', converted_opportunity_id = oid, owner_id = coalesce(owner_id, auth.uid()) where id = l.id;
  return oid;
end $$;

-- ------------------------------------------------------------ grants and RLS
revoke all on public.accounts, public.contacts, public.pipelines, public.stages, public.opportunities,
  public.opportunity_history, public.leads, public.activities from anon, authenticated;
revoke all on all functions in schema public from public, anon;
revoke all on all functions in schema app from public, anon;
grant execute on function app.can_read_record(uuid, uuid), app.can_write_record(uuid, uuid) to authenticated;
grant execute on function public.create_workspace(text, text), public.convert_lead(uuid, numeric) to authenticated;
grant execute on function public.capture_lead(text, text, text, text, text, text) to anon, authenticated;
-- Re-grant the Phase 1 RPCs (the blanket revoke above covers them too).
grant execute on function
  public.update_workspace(uuid, text), public.upsert_role(uuid, uuid, text, text, text[]), public.delete_role(uuid, uuid),
  public.invite_member(uuid, text, uuid), public.revoke_invitation(uuid, uuid), public.accept_invitation(text),
  public.change_member_role(uuid, uuid, uuid), public.set_member_status(uuid, uuid, text), public.remove_member(uuid, uuid)
  to authenticated;
grant execute on function app.caller_perms(uuid), app.is_member(uuid), app.has_perm(uuid, text), app.can_see_profile(uuid) to authenticated;

alter table public.accounts enable row level security;
alter table public.contacts enable row level security;
alter table public.pipelines enable row level security;
alter table public.stages enable row level security;
alter table public.opportunities enable row level security;
alter table public.opportunity_history enable row level security;
alter table public.leads enable row level security;
alter table public.activities enable row level security;

grant select, insert, update on public.accounts, public.contacts, public.opportunities, public.leads, public.activities to authenticated;
grant select, insert, update on public.pipelines, public.stages to authenticated;
grant select on public.opportunity_history to authenticated;

do $$ declare t text; begin
  foreach t in array array['accounts', 'contacts', 'opportunities', 'leads', 'activities'] loop
    execute format('create policy %1$s_read on public.%1$I for select to authenticated using (app.can_read_record(tenant_id, owner_id))', t);
    execute format('create policy %1$s_insert on public.%1$I for insert to authenticated with check (app.can_write_record(tenant_id, owner_id))', t);
    execute format('create policy %1$s_update on public.%1$I for update to authenticated using (app.can_write_record(tenant_id, owner_id)) with check (app.can_write_record(tenant_id, owner_id))', t);
  end loop;
end $$;

create policy pipelines_read on public.pipelines for select to authenticated using (app.is_member(tenant_id));
create policy pipelines_write on public.pipelines for insert to authenticated with check (app.has_perm(tenant_id, 'pipeline.configure'));
create policy pipelines_update on public.pipelines for update to authenticated using (app.has_perm(tenant_id, 'pipeline.configure')) with check (app.has_perm(tenant_id, 'pipeline.configure'));
create policy stages_read on public.stages for select to authenticated using (app.is_member(tenant_id));
create policy stages_write on public.stages for insert to authenticated with check (app.has_perm(tenant_id, 'pipeline.configure'));
create policy stages_update on public.stages for update to authenticated using (app.has_perm(tenant_id, 'pipeline.configure')) with check (app.has_perm(tenant_id, 'pipeline.configure'));
create policy history_read on public.opportunity_history for select to authenticated
  using (exists (select 1 from public.opportunities o where o.id = opportunity_id));
