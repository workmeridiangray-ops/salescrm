-- Teams (lead visibility), reassignment, won-deal handover, renewals, CSV import log, export audit.

insert into public.permissions (key, description) values
  ('records.reassign', 'Move a person''s records to someone else');

create or replace function app.system_role_permissions(k text) returns text[] language sql immutable as $$
  select case k
    when 'staff' then array['crm.write']
    when 'manager' then array['audit.view', 'crm.read_all', 'crm.write', 'forecast.manage', 'members.invite', 'members.view',
                              'pipeline.configure', 'products.manage', 'quotes.approve', 'records.reassign']
  end
$$;
update public.roles set permissions = app.system_role_permissions('manager') where is_system and key = 'manager';
update public.roles r set permissions = (select array_agg(key order by key) from public.permissions) where r.is_system and r.key = 'owner';

-- ---------------------------------------------------------------------- teams
create table public.teams (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 80),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, name)
);
create table public.team_members (
  tenant_id uuid not null,
  team_id uuid not null,
  user_id uuid not null,
  is_lead boolean not null default false,
  primary key (team_id, user_id),
  foreign key (tenant_id, team_id) references public.teams (tenant_id, id) on delete cascade,
  foreign key (tenant_id, user_id) references public.memberships (tenant_id, user_id) on delete cascade
);

-- A team lead can see and work on records owned by people in their team(s).
create function app.is_team_lead_of(t uuid, owner uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select owner is not null and exists (
    select 1 from team_members l join team_members m on m.team_id = l.team_id
     where l.tenant_id = t and l.user_id = auth.uid() and l.is_lead and m.user_id = owner)
$$;

create or replace function app.can_read_record(t uuid, owner uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select app.has_perm(t, 'crm.read_all')
      or (app.has_perm(t, 'crm.write') and (owner = auth.uid() or app.is_team_lead_of(t, owner)))
$$;
create or replace function app.can_write_record(t uuid, owner uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select app.has_perm(t, 'crm.write') and (app.has_perm(t, 'crm.read_all') or owner = auth.uid() or app.is_team_lead_of(t, owner))
$$;

-- ---------------------------------------------------------------- reassignment
create function public.member_workload(p_tenant uuid, p_user uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform app.require_perm(p_tenant, 'records.reassign');
  return jsonb_build_object(
    'accounts',      (select count(*) from accounts where tenant_id = p_tenant and owner_id = p_user and archived_at is null),
    'contacts',      (select count(*) from contacts where tenant_id = p_tenant and owner_id = p_user and archived_at is null),
    'leads',         (select count(*) from leads where tenant_id = p_tenant and owner_id = p_user and status in ('new', 'qualified')),
    'opportunities', (select count(*) from opportunities where tenant_id = p_tenant and owner_id = p_user and status = 'open' and archived_at is null),
    'open_tasks',    (select count(*) from activities where tenant_id = p_tenant and owner_id = p_user and done_at is null),
    'open_quotes',   (select count(*) from quotes where tenant_id = p_tenant and owner_id = p_user and status in ('draft', 'pending_approval', 'approved', 'sent')));
end $$;

-- Departure checklist step: hand everything live over in one transaction.
create function public.reassign_records(p_tenant uuid, p_from uuid, p_to uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare a int; c int; l int; o int; t int; q int;
begin
  perform app.require_perm(p_tenant, 'records.reassign');
  if p_from = p_to then raise exception 'same_person'; end if;
  if not exists (select 1 from memberships m join roles r on r.id = m.role_id
                  where m.tenant_id = p_tenant and m.user_id = p_to and m.status = 'active' and 'crm.write' = any (r.permissions)) then
    raise exception 'owner_not_member';
  end if;
  update accounts set owner_id = p_to where tenant_id = p_tenant and owner_id = p_from and archived_at is null; get diagnostics a = row_count;
  update contacts set owner_id = p_to where tenant_id = p_tenant and owner_id = p_from and archived_at is null; get diagnostics c = row_count;
  update leads set owner_id = p_to where tenant_id = p_tenant and owner_id = p_from and status in ('new', 'qualified'); get diagnostics l = row_count;
  update opportunities set owner_id = p_to where tenant_id = p_tenant and owner_id = p_from and status = 'open' and archived_at is null; get diagnostics o = row_count;
  update activities set owner_id = p_to where tenant_id = p_tenant and owner_id = p_from and done_at is null; get diagnostics t = row_count;
  update quotes set owner_id = p_to where tenant_id = p_tenant and owner_id = p_from and status in ('draft', 'pending_approval', 'approved', 'sent'); get diagnostics q = row_count;
  perform app.log(p_tenant, 'records.reassigned', 'membership', p_from::text,
    jsonb_build_object('to', p_to, 'accounts', a, 'contacts', c, 'leads', l, 'opportunities', o, 'tasks', t, 'quotes', q));
  return jsonb_build_object('accounts', a, 'contacts', c, 'leads', l, 'opportunities', o, 'open_tasks', t, 'open_quotes', q);
end $$;

-- ------------------------------------------------------------ renewals/kinds
alter table public.opportunities add column kind text not null default 'new' check (kind in ('new', 'renewal', 'expansion'));
alter table public.opportunities add column source_opportunity_id uuid;
alter table public.opportunities add foreign key (tenant_id, source_opportunity_id) references public.opportunities (tenant_id, id);

create function public.create_renewal(p_opportunity uuid, p_date date, p_kind text default 'renewal') returns uuid
language plpgsql set search_path = public, pg_temp as $$   -- SECURITY INVOKER: RLS decides
declare o opportunities; sid uuid; nid uuid;
begin
  if p_kind not in ('renewal', 'expansion') then raise exception 'invalid_request'; end if;
  select * into o from opportunities where id = p_opportunity;
  if not found then raise exception 'opportunity_not_found'; end if;
  if o.status <> 'won' then raise exception 'opportunity_not_won'; end if;
  select id into sid from stages where pipeline_id = o.pipeline_id and kind = 'open' order by position limit 1;
  insert into opportunities (tenant_id, name, account_id, contact_id, pipeline_id, stage_id, amount, expected_close, kind, source_opportunity_id, next_action, next_action_due)
  values (o.tenant_id, initcap(p_kind) || ': ' || o.name, o.account_id, o.contact_id, o.pipeline_id, sid, o.amount, p_date, p_kind, o.id,
          'Contact customer about ' || p_kind, greatest(current_date, p_date - 60))
  returning id into nid;
  return nid;
end $$;

-- ------------------------------------------------------------------- handover
create table public.handovers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  opportunity_id uuid not null,
  account_id uuid,
  contact_id uuid,
  quote_id uuid,
  status text not null default 'pending' check (status in ('pending', 'in_progress', 'complete')),
  scope text check (scope is null or length(scope) <= 4000),
  commercial_terms text check (commercial_terms is null or length(commercial_terms) <= 4000),
  commitments text check (commitments is null or length(commitments) <= 4000),
  renewal_date date,
  escalated_reason text,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, opportunity_id),
  foreign key (tenant_id, opportunity_id) references public.opportunities (tenant_id, id),
  foreign key (tenant_id, account_id) references public.accounts (tenant_id, id),
  foreign key (tenant_id, contact_id) references public.contacts (tenant_id, id),
  foreign key (tenant_id, quote_id) references public.quotes (tenant_id, id)
);
create table public.handover_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  handover_id uuid not null,
  label text not null check (length(trim(label)) between 1 and 200),
  position integer not null default 0,
  done_at timestamptz,
  done_by uuid,
  foreign key (tenant_id, handover_id) references public.handovers (tenant_id, id) on delete cascade
);

create function app.create_handover() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare h uuid; q quotes;
begin
  if new.status = 'won' and (tg_op = 'INSERT' or old.status <> 'won')
     and not exists (select 1 from handovers where opportunity_id = new.id) then
    select * into q from quotes where opportunity_id = new.id and status = 'accepted' order by version desc limit 1;
    insert into handovers (tenant_id, opportunity_id, account_id, contact_id, quote_id, commercial_terms)
    values (new.tenant_id, new.id, new.account_id, new.contact_id, q.id,
            case when q.id is not null then format('Quote %s v%s accepted by %s. Total INR %s incl. GST.', q.number, q.version, coalesce(q.responded_by_name, 'customer'), q.total)
                 else format('Won at INR %s (no accepted quote recorded).', new.amount) end)
    returning id into h;
    insert into handover_items (tenant_id, handover_id, label, position) values
      (new.tenant_id, h, 'Customer contacts and decision makers confirmed', 0),
      (new.tenant_id, h, 'Purchase order / signed agreement received', 1),
      (new.tenant_id, h, 'Delivery team briefed on scope and commitments', 2),
      (new.tenant_id, h, 'Invoice raised in the billing system', 3),
      (new.tenant_id, h, 'Kick-off scheduled with the customer', 4);
    perform app.log(new.tenant_id, 'handover.created', 'handover', h::text, jsonb_build_object('opportunity', new.id));
  end if;
  return null;
end $$;
create trigger create_handover after insert or update on public.opportunities for each row execute function app.create_handover();

create function app.handover_writable(hid uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from handovers h join opportunities o on o.id = h.opportunity_id
                  where h.id = hid and app.can_write_record(o.tenant_id, o.owner_id))
$$;
create function app.handover_readable(hid uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from handovers h join opportunities o on o.id = h.opportunity_id
                  where h.id = hid and app.can_read_record(o.tenant_id, o.owner_id))
$$;

create function public.complete_handover(p_handover uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare h handovers;
begin
  perform app.require_user();
  select * into h from handovers where id = p_handover for update;
  if not found or not app.handover_readable(p_handover) then raise exception 'handover_not_found'; end if;
  if not app.handover_writable(p_handover) then raise exception 'forbidden' using errcode = '42501'; end if;
  if h.status = 'complete' then raise exception 'handover_already_complete'; end if;
  if exists (select 1 from handover_items where handover_id = p_handover and done_at is null) then raise exception 'handover_incomplete'; end if;
  update handovers set status = 'complete', completed_at = now() where id = p_handover;
  perform app.log(h.tenant_id, 'handover.completed', 'handover', p_handover::text);
end $$;

create function public.set_handover_item(p_item uuid, p_done boolean) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare i handover_items;
begin
  perform app.require_user();
  select * into i from handover_items where id = p_item;
  if not found or not app.handover_readable(i.handover_id) then raise exception 'handover_not_found'; end if;
  if not app.handover_writable(i.handover_id) then raise exception 'forbidden' using errcode = '42501'; end if;
  if (select status from handovers where id = i.handover_id) = 'complete' then raise exception 'handover_already_complete'; end if;
  update handover_items set done_at = case when p_done then now() end, done_by = case when p_done then auth.uid() end where id = p_item;
  update handovers set status = 'in_progress' where id = i.handover_id and status = 'pending';
end $$;

-- ------------------------------------------------------- import log and export
create table public.import_jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  entity text not null check (entity in ('accounts', 'contacts', 'leads')),
  total integer not null,
  imported integer not null,
  failed integer not null,
  errors jsonb not null default '[]'::jsonb,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);

-- Row-by-row so one bad row never blocks the rest. SECURITY INVOKER: every
-- insert is checked by the caller's own RLS and ownership rules.
create function public.import_rows(p_tenant uuid, p_entity text, p_rows jsonb) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare r jsonb; i int := 0; res jsonb := '[]'::jsonb; ok int := 0; aid uuid; msg text;
begin
  if p_entity not in ('accounts', 'contacts', 'leads') then raise exception 'invalid_request'; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 2000 then raise exception 'too_many_rows'; end if;
  if not app.has_perm(p_tenant, 'crm.write') then raise exception 'forbidden' using errcode = '42501'; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    i := i + 1; msg := null;
    begin
      if p_entity = 'accounts' then
        insert into accounts (tenant_id, name, domain, industry, source)
        values (p_tenant, trim(r ->> 'name'), nullif(lower(trim(r ->> 'domain')), ''), nullif(trim(r ->> 'industry'), ''), 'import');
      elsif p_entity = 'contacts' then
        aid := null;
        if nullif(trim(r ->> 'account'), '') is not null then
          select id into aid from accounts where tenant_id = p_tenant and lower(name) = lower(trim(r ->> 'account')) and archived_at is null;
          if aid is null then raise exception 'account_not_found'; end if;
        end if;
        insert into contacts (tenant_id, account_id, full_name, email, phone, job_title, source)
        values (p_tenant, aid, trim(r ->> 'name'), nullif(lower(trim(r ->> 'email')), ''), nullif(trim(r ->> 'phone'), ''), nullif(trim(r ->> 'title'), ''), 'import');
      else
        insert into leads (tenant_id, name, email, company, phone, message, source, owner_id)
        values (p_tenant, trim(r ->> 'name'), nullif(lower(trim(r ->> 'email')), ''), nullif(trim(r ->> 'company'), ''), nullif(trim(r ->> 'phone'), ''),
                nullif(trim(r ->> 'message'), ''), 'import', auth.uid());
      end if;
      ok := ok + 1;
    exception when others then
      msg := sqlerrm;
    end;
    if msg is not null then res := res || jsonb_build_object('row', coalesce((r ->> '_line')::int, i), 'error', msg); end if;
  end loop;
  insert into import_jobs (tenant_id, entity, total, imported, failed, errors)
  values (p_tenant, p_entity, i, ok, i - ok, res);
  return jsonb_build_object('total', i, 'imported', ok, 'failed', res);
end $$;

create function public.log_export(p_tenant uuid, p_entity text, p_rows integer) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.require_perm(p_tenant, 'crm.export');
  perform app.log(p_tenant, 'export.downloaded', p_entity, null, jsonb_build_object('rows', p_rows));
end $$;

-- ----------------------------------------------------------- grants and RLS
revoke all on public.teams, public.team_members, public.handovers, public.handover_items, public.import_jobs from anon, authenticated;
revoke execute on function app.is_team_lead_of(uuid, uuid), app.handover_writable(uuid), app.handover_readable(uuid), app.create_handover(),
  public.member_workload(uuid, uuid), public.reassign_records(uuid, uuid, uuid), public.create_renewal(uuid, date, text),
  public.complete_handover(uuid), public.set_handover_item(uuid, boolean), public.import_rows(uuid, text, jsonb), public.log_export(uuid, text, integer) from public, anon;
grant execute on function app.is_team_lead_of(uuid, uuid), app.handover_writable(uuid), app.handover_readable(uuid) to authenticated;
grant execute on function public.member_workload(uuid, uuid), public.reassign_records(uuid, uuid, uuid), public.create_renewal(uuid, date, text),
  public.complete_handover(uuid), public.set_handover_item(uuid, boolean), public.import_rows(uuid, text, jsonb), public.log_export(uuid, text, integer) to authenticated;

alter table public.teams enable row level security;
alter table public.team_members enable row level security;
alter table public.handovers enable row level security;
alter table public.handover_items enable row level security;
alter table public.import_jobs enable row level security;

grant select, insert, update, delete on public.teams, public.team_members to authenticated;
grant select on public.handovers, public.handover_items, public.import_jobs to authenticated;
grant update (scope, commercial_terms, commitments, renewal_date, escalated_reason) on public.handovers to authenticated;
grant insert on public.import_jobs to authenticated;  -- written only by import_rows (invoker) on the caller's behalf

create policy teams_read on public.teams for select to authenticated using (app.is_member(tenant_id));
create policy teams_write on public.teams for all to authenticated using (app.has_perm(tenant_id, 'members.manage')) with check (app.has_perm(tenant_id, 'members.manage'));
create policy team_members_read on public.team_members for select to authenticated using (app.is_member(tenant_id));
create policy team_members_write on public.team_members for all to authenticated using (app.has_perm(tenant_id, 'members.manage')) with check (app.has_perm(tenant_id, 'members.manage'));
create policy handovers_read on public.handovers for select to authenticated using (app.handover_readable(id));
create policy handovers_update on public.handovers for update to authenticated using (app.handover_writable(id)) with check (app.handover_writable(id));
create policy handover_items_read on public.handover_items for select to authenticated using (app.handover_readable(handover_id));
create policy import_jobs_read on public.import_jobs for select to authenticated using (app.has_perm(tenant_id, 'crm.read_all') or created_by = auth.uid());
create policy import_jobs_insert on public.import_jobs for insert to authenticated with check (app.has_perm(tenant_id, 'crm.write'));
