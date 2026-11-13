-- Territory rules for incoming leads, scheduled report emails.
-- Territory semantics (documented defaults): rules are evaluated top to bottom, the FIRST rule whose
-- owner is an active writer wins, leads that match nothing fall through to round robin, and rules only
-- ever route NEW or UNASSIGNED leads - they never take a record away from someone who already owns it.

create table public.territory_rules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  position integer not null check (position >= 0),
  match_field text not null check (match_field = 'email_domain'),
  match_value text not null check (match_value = lower(match_value) and match_value ~ '^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$'),
  owner_id uuid not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, position) deferrable initially deferred,
  unique (tenant_id, match_field, match_value),
  foreign key (tenant_id, owner_id) references public.memberships (tenant_id, user_id) on delete cascade
);

-- First matching rule whose owner can still take leads; null = no territory match.
create function app.territory_owner(t uuid, mail text) returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select r.owner_id from territory_rules r
    join memberships m on m.tenant_id = r.tenant_id and m.user_id = r.owner_id and m.status = 'active'
    join roles ro on ro.id = m.role_id and 'crm.write' = any (ro.permissions)
   where r.tenant_id = t and mail like '%@%'
     and (split_part(mail, '@', 2) = r.match_value or split_part(mail, '@', 2) like '%.' || r.match_value)
   order by r.position limit 1
$$;

create function public.add_territory_rule(p_tenant uuid, p_domain text, p_owner uuid) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare id uuid; n int;
begin
  perform app.require_perm(p_tenant, 'records.reassign');
  select count(*) into n from territory_rules where tenant_id = p_tenant;
  if n >= 50 then raise exception 'rule_limit'; end if;
  if not exists (select 1 from memberships m join roles r on r.id = m.role_id where m.tenant_id = p_tenant and m.user_id = p_owner and m.status = 'active' and 'crm.write' = any (r.permissions)) then
    raise exception 'owner_not_member';
  end if;
  insert into territory_rules (tenant_id, position, match_field, match_value, owner_id)
  values (p_tenant, n, 'email_domain', lower(trim(p_domain)), p_owner) returning territory_rules.id into id;
  perform app.log(p_tenant, 'territory.rule_added', 'territory_rule', id::text, jsonb_build_object('domain', lower(trim(p_domain)), 'owner', p_owner));
  return id;
end $$;

create function public.delete_territory_rule(p_tenant uuid, p_rule uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare pos int;
begin
  perform app.require_perm(p_tenant, 'records.reassign');
  select position into pos from territory_rules where id = p_rule and tenant_id = p_tenant;
  if not found then raise exception 'rule_not_found'; end if;
  set constraints all deferred;
  delete from territory_rules where id = p_rule;
  update territory_rules set position = position - 1 where tenant_id = p_tenant and position > pos;
  perform app.log(p_tenant, 'territory.rule_deleted', 'territory_rule', p_rule::text);
end $$;

create function public.move_territory_rule(p_tenant uuid, p_rule uuid, p_direction integer) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare r territory_rules; o territory_rules;
begin
  perform app.require_perm(p_tenant, 'records.reassign');
  select * into r from territory_rules where id = p_rule and tenant_id = p_tenant;
  if not found then raise exception 'rule_not_found'; end if;
  select * into o from territory_rules where tenant_id = p_tenant and position = r.position + case when p_direction < 0 then -1 else 1 end;
  if not found then return; end if;
  set constraints all deferred;
  update territory_rules set position = o.position where id = r.id;
  update territory_rules set position = r.position where id = o.id;
end $$;

-- Routes currently unassigned open leads by the rules. Returns how many moved.
create function public.apply_territory_rules(p_tenant uuid) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare l record; who uuid; n int := 0;
begin
  perform app.require_perm(p_tenant, 'records.reassign');
  for l in select id, email from leads where tenant_id = p_tenant and owner_id is null and status in ('new', 'qualified') and email is not null loop
    who := app.territory_owner(p_tenant, l.email);
    if who is not null then update leads set owner_id = who where id = l.id; n := n + 1; end if;
  end loop;
  perform app.log(p_tenant, 'territory.applied', 'territory_rule', null, jsonb_build_object('leads_assigned', n));
  return n;
end $$;

-- Web/API capture now consults territory rules before round robin.
create or replace function public.capture_lead(p_slug text, p_name text, p_email text, p_company text, p_phone text, p_message text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare t tenants; mail text := nullif(lower(trim(coalesce(p_email, ''))), ''); who uuid;
begin
  select * into t from tenants where slug = lower(trim(p_slug)) and status <> 'suspended';
  if not found then return; end if;
  if length(trim(coalesce(p_name, ''))) = 0 or length(p_name) > 160 or length(coalesce(p_message, '')) > 2000
     or (mail is not null and (position('@' in mail) < 2 or length(mail) > 200)) then
    raise exception 'invalid_lead';
  end if;
  if mail is not null then who := app.territory_owner(t.id, mail); end if;
  if who is null then
    select m.user_id into who
      from memberships m join roles r on r.id = m.role_id
     where m.tenant_id = t.id and m.status = 'active' and 'crm.write' = any (r.permissions)
     order by (select count(*) from leads l where l.tenant_id = t.id and l.owner_id = m.user_id and l.status in ('new', 'qualified')), m.created_at
     limit 1;
  end if;
  insert into leads (tenant_id, name, email, company, phone, message, source, owner_id, created_by)
  values (t.id, trim(p_name), mail, nullif(trim(coalesce(p_company, '')), ''), nullif(trim(coalesce(p_phone, '')), ''),
          nullif(trim(coalesce(p_message, '')), ''), 'web', who, null)
  on conflict (tenant_id, email) where email is not null and status in ('new', 'qualified')
  do update set message = coalesce(nullif(trim(coalesce(excluded.message, '')), ''), leads.message);
end $$;

-- ====================================================== scheduled report emails
create table public.report_schedules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  report text not null check (report in ('lead_sources', 'funnel', 'sales_cycle', 'stage_ageing', 'seller_performance', 'losses')),
  range_days integer not null check (range_days in (7, 30, 90)),
  frequency text not null check (frequency in ('weekly', 'monthly')),
  recipients text[] not null check (cardinality(recipients) between 1 and 10),
  created_by uuid default auth.uid(),
  active boolean not null default true,
  next_run_at timestamptz not null,
  last_run_at timestamptz,
  last_error text,
  created_at timestamptz not null default now()
);

-- Weekly = next Monday 07:00 India time; monthly = the 1st of next month 07:00.
create function app.next_run(freq text, after timestamptz default now()) returns timestamptz language sql stable as $$
  select case freq
    when 'weekly' then (date_trunc('week', after at time zone 'Asia/Kolkata') + interval '7 days' + interval '7 hours') at time zone 'Asia/Kolkata'
    else (date_trunc('month', after at time zone 'Asia/Kolkata') + interval '1 month' + interval '7 hours') at time zone 'Asia/Kolkata' end
$$;

create function public.create_report_schedule(p_tenant uuid, p_report text, p_range_days integer, p_frequency text, p_recipients text[]) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare id uuid; mails text[]; bad text;
begin
  perform app.require_perm(p_tenant, 'crm.export');
  if not app.has_perm(p_tenant, 'crm.read_all') then raise exception 'forbidden' using errcode = '42501'; end if;  -- scheduled reports are workspace-wide
  select array_agg(distinct lower(trim(x))) into mails from unnest(p_recipients) x;
  select x into bad from unnest(mails) x where x not in (select p.email from memberships m join profiles p on p.id = m.user_id where m.tenant_id = p_tenant and m.status = 'active') limit 1;
  if bad is not null then raise exception 'recipient_not_member'; end if;   -- never emails outsiders
  if (select count(*) from report_schedules where tenant_id = p_tenant and active) >= 10 then raise exception 'schedule_limit'; end if;
  insert into report_schedules (tenant_id, report, range_days, frequency, recipients, next_run_at)
  values (p_tenant, p_report, p_range_days, p_frequency, mails, app.next_run(p_frequency)) returning report_schedules.id into id;
  perform app.log(p_tenant, 'report_schedule.created', 'report_schedule', id::text, jsonb_build_object('report', p_report, 'frequency', p_frequency, 'recipients', mails));
  return id;
end $$;

create function public.delete_report_schedule(p_tenant uuid, p_schedule uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.require_perm(p_tenant, 'crm.export');
  update report_schedules set active = false where id = p_schedule and tenant_id = p_tenant and active;
  if not found then raise exception 'schedule_not_found'; end if;
  perform app.log(p_tenant, 'report_schedule.deleted', 'report_schedule', p_schedule::text);
end $$;

-- Dispatcher (service role). The next run is set at claim time, so a crash can't cause repeated sends.
create function public.report_schedules_claim(p_limit integer)
returns table (id uuid, tenant_id uuid, tenant_name text, report text, range_days integer, recipients text[])
language sql security definer set search_path = public, pg_temp as $$
  with due as (
    select s.id from report_schedules s join tenants t on t.id = s.tenant_id and t.status <> 'suspended'
     where s.active and s.next_run_at <= now() order by s.next_run_at limit greatest(1, least(coalesce(p_limit, 10), 50)) for update of s skip locked)
  update report_schedules s set last_run_at = now(), last_error = null, next_run_at = app.next_run(s.frequency)
    from due, tenants t where s.id = due.id and t.id = s.tenant_id
  returning s.id, s.tenant_id, t.name, s.report, s.range_days, s.recipients
$$;

create function public.report_schedule_result(p_id uuid, p_error text) returns void
language sql security definer set search_path = public, pg_temp as $$
  update report_schedules set last_error = left(p_error, 300) where id = p_id
$$;

-- ------------------------------------------------------------ grants and RLS
revoke all on public.territory_rules, public.report_schedules from anon, authenticated;
revoke execute on function app.territory_owner(uuid, text), app.next_run(text, timestamptz), public.add_territory_rule(uuid, text, uuid), public.delete_territory_rule(uuid, uuid),
  public.move_territory_rule(uuid, uuid, integer), public.apply_territory_rules(uuid), public.create_report_schedule(uuid, text, integer, text, text[]),
  public.delete_report_schedule(uuid, uuid), public.report_schedules_claim(integer), public.report_schedule_result(uuid, text) from public, anon;
grant execute on function public.add_territory_rule(uuid, text, uuid), public.delete_territory_rule(uuid, uuid), public.move_territory_rule(uuid, uuid, integer),
  public.apply_territory_rules(uuid), public.create_report_schedule(uuid, text, integer, text, text[]), public.delete_report_schedule(uuid, uuid) to authenticated;
grant execute on function public.report_schedules_claim(integer), public.report_schedule_result(uuid, text) to service_role;
grant execute on function public.report_lead_sources(uuid, date, date), public.report_funnel(uuid, date, date), public.report_sales_cycle(uuid, date, date),
  public.report_stage_ageing(uuid), public.report_seller_performance(uuid, date, date), public.report_losses(uuid, date, date) to service_role;
grant execute on function public.capture_lead(text, text, text, text, text, text) to anon, authenticated;

alter table public.territory_rules enable row level security;
alter table public.report_schedules enable row level security;
grant select on public.territory_rules, public.report_schedules to authenticated;
create policy territory_read on public.territory_rules for select to authenticated using (app.has_perm(tenant_id, 'records.reassign') or app.has_perm(tenant_id, 'crm.read_all'));
create policy schedules_read on public.report_schedules for select to authenticated using (app.has_perm(tenant_id, 'crm.read_all') and app.has_perm(tenant_id, 'crm.export'));
