-- Quotes (catalogue, versions, discount approval, customer review) and
-- forecasting (calculated vs overrides vs targets, immutable snapshots).

insert into public.permissions (key, description) values
  ('quotes.approve',  'Approve discounted quotes and revise accepted ones'),
  ('forecast.manage', 'Set targets, adjust forecasts and take snapshots'),
  ('products.manage', 'Manage the product catalogue');

-- One definition of the built-in roles, used by create_workspace.
create function app.system_role_permissions(k text) returns text[] language sql immutable as $$
  select case k
    when 'staff' then array['crm.write']
    when 'manager' then array['audit.view', 'crm.read_all', 'crm.write', 'forecast.manage', 'members.invite', 'members.view',
                              'pipeline.configure', 'products.manage', 'quotes.approve']
  end
$$;
update public.roles set permissions = app.system_role_permissions('manager') where is_system and key = 'manager';
update public.roles r set permissions = (select array_agg(key order by key) from public.permissions) where r.is_system and r.key = 'owner';

create or replace function public.create_workspace(p_name text, p_slug text) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare tid uuid; owner_role uuid; pid uuid; me uuid := app.require_user();
begin
  insert into tenants (name, slug) values (trim(p_name), lower(trim(p_slug))) returning id into tid;
  insert into roles (tenant_id, key, name, permissions, is_system) values
    (tid, 'staff',   'Staff',   app.system_role_permissions('staff'), true),
    (tid, 'manager', 'Manager', app.system_role_permissions('manager'), true);
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

alter table public.tenants add column discount_approval_pct numeric(5, 2) not null default 10 check (discount_approval_pct between 0 and 100);
create function public.set_discount_threshold(p_tenant uuid, p_pct numeric) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.require_perm(p_tenant, 'tenant.configure');
  if p_pct is null or p_pct < 0 or p_pct > 100 then raise exception 'invalid_request'; end if;
  update tenants set discount_approval_pct = p_pct where id = p_tenant;
  perform app.log(p_tenant, 'tenant.discount_threshold', 'tenant', p_tenant::text, jsonb_build_object('pct', p_pct));
end $$;

-- Opportunities remember when they closed (needed for "won this period").
alter table public.opportunities add column closed_at timestamptz;
create or replace function app.opportunity_stage_rules() returns trigger language plpgsql as $$
declare k text;
begin
  select kind into k from stages where id = new.stage_id;
  new.status := case k when 'won' then 'won' when 'lost' then 'lost' else 'open' end;
  if new.status = 'lost' and length(trim(coalesce(new.loss_reason, ''))) = 0 then raise exception 'loss_reason_required'; end if;
  if new.status <> 'lost' then new.loss_reason := null; end if;
  if new.status = 'open' then new.closed_at := null;
  elsif tg_op = 'INSERT' or old.status = 'open' then new.closed_at := now(); end if;
  return new;
end $$;

-- ------------------------------------------------------------------ catalogue
create table public.products (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  sku text,
  name text not null check (length(trim(name)) between 1 and 160),
  unit_price numeric(14, 2) not null check (unit_price >= 0),
  tax_rate numeric(5, 2) not null default 18 check (tax_rate between 0 and 100),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, id)
);
create unique index products_sku_unique on public.products (tenant_id, lower(sku)) where sku is not null;

create table public.counters (
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  name text not null,
  value bigint not null default 0,
  primary key (tenant_id, name)
);
create function app.next_number(t uuid, n text) returns bigint language sql security definer set search_path = public, pg_temp as $$
  insert into counters (tenant_id, name, value) values (t, n, 1)
  on conflict (tenant_id, name) do update set value = counters.value + 1 returning value
$$;

-- --------------------------------------------------------------------- quotes
create table public.quotes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  opportunity_id uuid not null,
  quote_group uuid not null default gen_random_uuid(),
  version integer not null default 1 check (version >= 1),
  number text not null default '',
  status text not null default 'draft' check (status in
    ('draft', 'pending_approval', 'approved', 'sent', 'accepted', 'rejected', 'expired', 'superseded')),
  valid_until date not null,
  discount_pct numeric(5, 2) not null default 0 check (discount_pct between 0 and 100),
  subtotal numeric(14, 2) not null default 0,
  discount_total numeric(14, 2) not null default 0,
  tax_total numeric(14, 2) not null default 0,
  total numeric(14, 2) not null default 0,
  notes text check (notes is null or length(notes) <= 2000),
  review_token_hash text unique,
  sent_at timestamptz,
  responded_at timestamptz,
  responded_by_name text,
  decision_reason text,
  approved_by uuid,
  owner_id uuid default auth.uid(),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, quote_group, version),
  foreign key (tenant_id, opportunity_id) references public.opportunities (tenant_id, id)
);
create index quotes_opp_idx on public.quotes (tenant_id, opportunity_id);

create table public.quote_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  quote_id uuid not null,
  product_id uuid,
  description text not null check (length(trim(description)) between 1 and 300),
  qty numeric(12, 3) not null check (qty > 0),
  unit_price numeric(14, 2) not null check (unit_price >= 0),
  tax_rate numeric(5, 2) not null default 18 check (tax_rate between 0 and 100),
  position integer not null default 0,
  foreign key (tenant_id, quote_id) references public.quotes (tenant_id, id) on delete cascade,
  foreign key (tenant_id, product_id) references public.products (tenant_id, id)
);
create index quote_lines_quote_idx on public.quote_lines (quote_id);

-- Money rule (mirrored in lib/rules/quote.ts; parity test keeps them equal):
-- per line: net = round(qty*price,2); discount = round(net*d/100,2); tax = round((net-discount)*rate/100,2).
create function app.quote_totals(qid uuid, d numeric, out subtotal numeric, out discount_total numeric, out tax_total numeric, out total numeric)
language sql stable as $$
  with l as (
    select round(qty * unit_price, 2) as net, tax_rate from quote_lines where quote_id = qid
  ), x as (
    select net, round(net * d / 100, 2) as disc, tax_rate from l
  )
  select coalesce(sum(net), 0), coalesce(sum(disc), 0),
         coalesce(sum(round((net - disc) * tax_rate / 100, 2)), 0),
         coalesce(sum(net - disc + round((net - disc) * tax_rate / 100, 2)), 0)
  from x
$$;

create function app.quote_before() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.number = '' then new.number := 'Q-' || lpad(app.next_number(new.tenant_id, 'quote')::text, 5, '0'); end if;
  elsif old.status <> 'draft' and (new.discount_pct, new.valid_until, new.notes, new.opportunity_id)
        is distinct from (old.discount_pct, old.valid_until, old.notes, old.opportunity_id) then
    raise exception 'quote_locked';
  end if;
  select t.subtotal, t.discount_total, t.tax_total, t.total into new.subtotal, new.discount_total, new.tax_total, new.total
    from app.quote_totals(new.id, new.discount_pct) t;
  return new;
end $$;
create trigger quote_before before insert or update on public.quotes for each row execute function app.quote_before();
create trigger lock_tenant before update on public.quotes for each row execute function app.lock_tenant_id();
create trigger check_owner before insert or update on public.quotes for each row execute function app.check_owner();

create function app.quote_lines_guard() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare qid uuid := coalesce(new.quote_id, old.quote_id); st text;
begin
  select status into st from quotes where id = qid;
  if st is distinct from 'draft' then raise exception 'quote_locked'; end if;
  return coalesce(new, old);
end $$;
create trigger quote_lines_guard before insert or update or delete on public.quote_lines for each row execute function app.quote_lines_guard();

create function app.quote_lines_recalc() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update quotes set discount_pct = discount_pct where id = coalesce(new.quote_id, old.quote_id);  -- re-runs quote_before
  return null;
end $$;
create trigger quote_lines_recalc after insert or update or delete on public.quote_lines for each row execute function app.quote_lines_recalc();

-- ---- quote workflow RPCs
create function app.quote_for_update(qid uuid, out q quotes) language plpgsql security definer set search_path = public, pg_temp as $$
begin
  select * into q from quotes where id = qid for update;
  if not found or not app.can_read_record(q.tenant_id, q.owner_id) then raise exception 'quote_not_found'; end if;
end $$;

create function public.create_quote(p_opportunity uuid, p_valid_days integer default 30) returns uuid
language plpgsql set search_path = public, pg_temp as $$   -- SECURITY INVOKER: RLS decides
declare o opportunities; qid uuid;
begin
  select * into o from opportunities where id = p_opportunity;
  if not found then raise exception 'opportunity_not_found'; end if;
  insert into quotes (tenant_id, opportunity_id, valid_until) values (o.tenant_id, o.id, current_date + greatest(least(coalesce(p_valid_days, 30), 365), 1))
  returning id into qid;
  return qid;
end $$;

create function public.submit_quote(p_quote uuid) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare q quotes; thr numeric; st text;
begin
  perform app.require_user();
  q := app.quote_for_update(p_quote);
  if not app.can_write_record(q.tenant_id, q.owner_id) then raise exception 'forbidden' using errcode = '42501'; end if;
  if q.status <> 'draft' then raise exception 'quote_not_draft'; end if;
  if not exists (select 1 from quote_lines where quote_id = q.id) then raise exception 'quote_empty'; end if;
  if q.valid_until < current_date then raise exception 'quote_expired'; end if;
  select discount_approval_pct into thr from tenants where id = q.tenant_id;
  st := case when q.discount_pct > thr then 'pending_approval' else 'approved' end;
  update quotes set status = st where id = q.id;
  perform app.log(q.tenant_id, 'quote.submitted', 'quote', q.id::text, jsonb_build_object('number', q.number, 'discount_pct', q.discount_pct, 'result', st));
  return st;
end $$;

create function public.approve_quote(p_quote uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare q quotes; is_owner boolean;
begin
  perform app.require_user();
  q := app.quote_for_update(p_quote);
  perform app.require_perm(q.tenant_id, 'quotes.approve');
  if q.status <> 'pending_approval' then raise exception 'quote_not_pending'; end if;
  select exists (select 1 from memberships m join roles r on r.id = m.role_id where m.tenant_id = q.tenant_id and m.user_id = auth.uid() and r.key = 'owner') into is_owner;
  if q.created_by = auth.uid() and not is_owner then raise exception 'self_approval'; end if;
  update quotes set status = 'approved', approved_by = auth.uid() where id = q.id;
  perform app.log(q.tenant_id, 'quote.approved', 'quote', q.id::text, jsonb_build_object('number', q.number, 'discount_pct', q.discount_pct));
end $$;

create function public.reject_quote_approval(p_quote uuid, p_reason text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare q quotes;
begin
  perform app.require_user();
  q := app.quote_for_update(p_quote);
  perform app.require_perm(q.tenant_id, 'quotes.approve');
  if length(trim(coalesce(p_reason, ''))) = 0 then raise exception 'reason_required'; end if;
  if q.status <> 'pending_approval' then raise exception 'quote_not_pending'; end if;
  update quotes set status = 'draft', decision_reason = trim(p_reason) where id = q.id;
  perform app.log(q.tenant_id, 'quote.approval_rejected', 'quote', q.id::text, jsonb_build_object('number', q.number, 'reason', trim(p_reason)));
end $$;

-- Returns the one-time customer review token. Only a hash is stored.
create function public.send_quote(p_quote uuid) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare q quotes; tok text;
begin
  perform app.require_user();
  q := app.quote_for_update(p_quote);
  if not app.can_write_record(q.tenant_id, q.owner_id) then raise exception 'forbidden' using errcode = '42501'; end if;
  if q.status <> 'approved' then raise exception 'quote_not_approved'; end if;
  if q.valid_until < current_date then raise exception 'quote_expired'; end if;
  tok := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  update quotes set status = 'sent', sent_at = now(), review_token_hash = encode(sha256(convert_to(tok, 'utf8')), 'hex') where id = q.id;
  perform app.log(q.tenant_id, 'quote.sent', 'quote', q.id::text, jsonb_build_object('number', q.number, 'version', q.version));
  return tok;
end $$;

-- New draft version; the old one is superseded. Revising an ACCEPTED quote is
-- the defined change process: it needs quotes.approve.
create function public.revise_quote(p_quote uuid) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare q quotes; nid uuid;
begin
  perform app.require_user();
  q := app.quote_for_update(p_quote);
  if not app.can_write_record(q.tenant_id, q.owner_id) then raise exception 'forbidden' using errcode = '42501'; end if;
  if q.status in ('draft', 'superseded') then raise exception 'quote_not_revisable'; end if;
  if q.status = 'accepted' and not app.has_perm(q.tenant_id, 'quotes.approve') then raise exception 'revision_needs_approval' using errcode = '42501'; end if;
  insert into quotes (tenant_id, opportunity_id, quote_group, version, number, valid_until, discount_pct, notes, owner_id)
  values (q.tenant_id, q.opportunity_id, q.quote_group, (select max(version) + 1 from quotes where quote_group = q.quote_group),
          q.number, greatest(q.valid_until, current_date + 30), q.discount_pct, q.notes, q.owner_id)
  returning id into nid;
  insert into quote_lines (tenant_id, quote_id, product_id, description, qty, unit_price, tax_rate, position)
    select tenant_id, nid, product_id, description, qty, unit_price, tax_rate, position from quote_lines where quote_id = q.id;
  update quotes set status = 'superseded', review_token_hash = null where id = q.id;
  perform app.log(q.tenant_id, 'quote.revised', 'quote', nid::text, jsonb_build_object('number', q.number, 'from_version', q.version, 'from_status', q.status));
  return nid;
end $$;

create function public.expire_quotes(p_tenant uuid) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer;
begin
  perform app.require_perm(p_tenant, 'quotes.approve');
  update quotes set status = 'expired' where tenant_id = p_tenant and status = 'sent' and valid_until < current_date;
  get diagnostics n = row_count;
  return n;
end $$;

-- ---- customer review (no account; the unguessable token is the credential)
create function public.quote_for_review(p_token text) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare q quotes; t tenants;
begin
  select * into q from quotes where review_token_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'utf8')), 'hex');
  if not found then return null; end if;
  select * into t from tenants where id = q.tenant_id;
  return jsonb_build_object(
    'company', t.name, 'number', q.number, 'version', q.version, 'status', q.status,
    'expired', q.status = 'sent' and q.valid_until < current_date, 'valid_until', q.valid_until, 'notes', q.notes,
    'discount_pct', q.discount_pct, 'subtotal', q.subtotal, 'discount_total', q.discount_total, 'tax_total', q.tax_total, 'total', q.total,
    'responded_by', q.responded_by_name,
    'lines', coalesce((select jsonb_agg(jsonb_build_object('description', description, 'qty', qty, 'unit_price', unit_price, 'tax_rate', tax_rate) order by position, id)
                         from quote_lines where quote_id = q.id), '[]'::jsonb));
end $$;

create function public.respond_to_quote(p_token text, p_accept boolean, p_name text, p_reason text) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare q quotes; won uuid;
begin
  select * into q from quotes where review_token_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'utf8')), 'hex') for update;
  if not found then raise exception 'quote_not_found'; end if;
  if length(trim(coalesce(p_name, ''))) = 0 then raise exception 'name_required'; end if;
  if q.status <> 'sent' then raise exception 'quote_already_answered'; end if;
  if q.valid_until < current_date then
    update quotes set status = 'expired' where id = q.id;
    raise exception 'quote_expired';
  end if;
  update quotes set status = case when p_accept then 'accepted' else 'rejected' end, responded_at = now(),
         responded_by_name = trim(p_name), decision_reason = nullif(trim(coalesce(p_reason, '')), '') where id = q.id;
  if p_accept then
    select s.id into won from opportunities o join stages s on s.pipeline_id = o.pipeline_id and s.kind = 'won'
      where o.id = q.opportunity_id and o.status = 'open' order by s.position limit 1;
    if won is not null then update opportunities set stage_id = won, amount = q.total where id = q.opportunity_id; end if;  -- order handoff
  end if;
  perform app.log(q.tenant_id, 'quote.' || case when p_accept then 'accepted' else 'rejected' end, 'quote', q.id::text,
    jsonb_build_object('number', q.number, 'version', q.version, 'by', trim(p_name)));
  return case when p_accept then 'accepted' else 'rejected' end;
end $$;

-- ------------------------------------------------------------------- forecast
create table public.forecast_targets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  period text not null check (period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  owner_id uuid,  -- null = team target
  amount numeric(14, 2) not null check (amount >= 0),
  set_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create unique index forecast_targets_one on public.forecast_targets (tenant_id, period, coalesce(owner_id, '00000000-0000-0000-0000-000000000000'));

-- Overrides are append-only: the newest per (period, owner, category) wins, older ones stay as history.
create table public.forecast_overrides (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  period text not null check (period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  owner_id uuid not null,
  category text not null check (category in ('commit', 'best_case', 'pipeline')),
  amount numeric(14, 2) not null check (amount >= 0),
  reason text not null check (length(trim(reason)) > 0),
  set_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create trigger forecast_overrides_immutable before update or delete on public.forecast_overrides for each row execute function app.audit_log_immutable();

create table public.forecast_snapshots (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  period text not null check (period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  taken_by uuid default auth.uid(),
  taken_at timestamptz not null default now(),
  data jsonb not null
);
create index forecast_snapshots_idx on public.forecast_snapshots (tenant_id, period, id desc);
create trigger forecast_snapshots_immutable before update or delete on public.forecast_snapshots for each row execute function app.audit_log_immutable();

-- Calculated numbers per owner. SECURITY INVOKER: the caller's own RLS decides
-- which opportunities count (managers: all; staff: theirs).
-- Category follows stage probability: >=70 commit, >=40 best case, else pipeline.
create function public.forecast_rows(p_tenant uuid, p_period text)
returns table (owner_id uuid, commit_amount numeric, best_case_amount numeric, pipeline_amount numeric, weighted numeric, won numeric, open_count integer)
language sql stable set search_path = public, pg_temp as $$
  with bounds as (select to_date(p_period || '-01', 'YYYY-MM-DD') as s)
  select o.owner_id,
    coalesce(sum(o.amount) filter (where o.status = 'open' and st.probability >= 70 and o.expected_close >= b.s and o.expected_close < b.s + interval '1 month'), 0),
    coalesce(sum(o.amount) filter (where o.status = 'open' and st.probability >= 40 and st.probability < 70 and o.expected_close >= b.s and o.expected_close < b.s + interval '1 month'), 0),
    coalesce(sum(o.amount) filter (where o.status = 'open' and st.probability < 40 and o.expected_close >= b.s and o.expected_close < b.s + interval '1 month'), 0),
    coalesce(sum(o.amount * st.probability / 100) filter (where o.status = 'open' and o.expected_close >= b.s and o.expected_close < b.s + interval '1 month'), 0),
    coalesce(sum(o.amount) filter (where o.status = 'won' and o.closed_at >= b.s and o.closed_at < b.s + interval '1 month'), 0),
    (count(*) filter (where o.status = 'open' and o.expected_close >= b.s and o.expected_close < b.s + interval '1 month'))::int
  from opportunities o join stages st on st.id = o.stage_id, bounds b
  where o.tenant_id = p_tenant and o.archived_at is null
  group by o.owner_id
$$;

create function public.set_forecast_target(p_tenant uuid, p_period text, p_owner uuid, p_amount numeric) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.require_perm(p_tenant, 'forecast.manage');
  if p_owner is not null and not exists (select 1 from memberships where tenant_id = p_tenant and user_id = p_owner) then raise exception 'owner_not_member'; end if;
  insert into forecast_targets (tenant_id, period, owner_id, amount) values (p_tenant, p_period, p_owner, p_amount)
  on conflict (tenant_id, period, coalesce(owner_id, '00000000-0000-0000-0000-000000000000')) do update set amount = excluded.amount, set_by = auth.uid();
  perform app.log(p_tenant, 'forecast.target_set', 'forecast', p_period, jsonb_build_object('owner', p_owner, 'amount', p_amount));
end $$;

create function public.set_forecast_override(p_tenant uuid, p_period text, p_owner uuid, p_category text, p_amount numeric, p_reason text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.require_perm(p_tenant, 'forecast.manage');
  if length(trim(coalesce(p_reason, ''))) = 0 then raise exception 'reason_required'; end if;
  if not exists (select 1 from memberships where tenant_id = p_tenant and user_id = p_owner) then raise exception 'owner_not_member'; end if;
  insert into forecast_overrides (tenant_id, period, owner_id, category, amount, reason) values (p_tenant, p_period, p_owner, p_category, p_amount, trim(p_reason));
  perform app.log(p_tenant, 'forecast.override_set', 'forecast', p_period, jsonb_build_object('owner', p_owner, 'category', p_category, 'amount', p_amount, 'reason', trim(p_reason)));
end $$;

create function public.take_forecast_snapshot(p_tenant uuid, p_period text) returns bigint
language plpgsql security definer set search_path = public, pg_temp as $$
declare sid bigint; d jsonb;
begin
  perform app.require_perm(p_tenant, 'forecast.manage');
  select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) into d from forecast_rows(p_tenant, p_period) r;  -- definer: whole workspace
  insert into forecast_snapshots (tenant_id, period, data) values (p_tenant, p_period, d) returning id into sid;
  perform app.log(p_tenant, 'forecast.snapshot', 'forecast', p_period, jsonb_build_object('snapshot', sid));
  return sid;
end $$;

-- ------------------------------------------------------------ grants and RLS
revoke all on public.products, public.counters, public.quotes, public.quote_lines,
  public.forecast_targets, public.forecast_overrides, public.forecast_snapshots from anon, authenticated;
revoke execute on function
  app.system_role_permissions(text), app.next_number(uuid, text), app.quote_totals(uuid, numeric), app.quote_for_update(uuid),
  public.set_discount_threshold(uuid, numeric), public.create_quote(uuid, integer), public.submit_quote(uuid), public.approve_quote(uuid),
  public.reject_quote_approval(uuid, text), public.send_quote(uuid), public.revise_quote(uuid), public.expire_quotes(uuid),
  public.quote_for_review(text), public.respond_to_quote(text, boolean, text, text), public.forecast_rows(uuid, text),
  public.set_forecast_target(uuid, text, uuid, numeric), public.set_forecast_override(uuid, text, uuid, text, numeric, text),
  public.take_forecast_snapshot(uuid, text) from public, anon;
revoke execute on function public.create_workspace(text, text) from public, anon;
grant execute on function public.create_workspace(text, text), public.set_discount_threshold(uuid, numeric),
  public.create_quote(uuid, integer), public.submit_quote(uuid), public.approve_quote(uuid), public.reject_quote_approval(uuid, text),
  public.send_quote(uuid), public.revise_quote(uuid), public.expire_quotes(uuid), public.forecast_rows(uuid, text),
  public.set_forecast_target(uuid, text, uuid, numeric), public.set_forecast_override(uuid, text, uuid, text, numeric, text),
  public.take_forecast_snapshot(uuid, text) to authenticated;
-- Triggers run as the caller, so the caller needs EXECUTE on what they call.
grant execute on function app.quote_totals(uuid, numeric), app.next_number(uuid, text) to authenticated;
grant execute on function public.quote_for_review(text), public.respond_to_quote(text, boolean, text, text) to anon, authenticated;

alter table public.products enable row level security;
alter table public.counters enable row level security;
alter table public.quotes enable row level security;
alter table public.quote_lines enable row level security;
alter table public.forecast_targets enable row level security;
alter table public.forecast_overrides enable row level security;
alter table public.forecast_snapshots enable row level security;

grant select, insert, update on public.products to authenticated;
grant select, insert on public.quotes to authenticated;
grant update (discount_pct, valid_until, notes) on public.quotes to authenticated;
grant select, insert, update, delete on public.quote_lines to authenticated;
grant select on public.forecast_targets, public.forecast_overrides, public.forecast_snapshots to authenticated;

create policy products_read on public.products for select to authenticated using (app.is_member(tenant_id));
create policy products_insert on public.products for insert to authenticated with check (app.has_perm(tenant_id, 'products.manage'));
create policy products_update on public.products for update to authenticated using (app.has_perm(tenant_id, 'products.manage')) with check (app.has_perm(tenant_id, 'products.manage'));

create policy quotes_read on public.quotes for select to authenticated using (app.can_read_record(tenant_id, owner_id));
create policy quotes_insert on public.quotes for insert to authenticated with check (app.can_write_record(tenant_id, owner_id));
create policy quotes_update on public.quotes for update to authenticated using (app.can_write_record(tenant_id, owner_id)) with check (app.can_write_record(tenant_id, owner_id));

create policy quote_lines_read on public.quote_lines for select to authenticated
  using (exists (select 1 from public.quotes q where q.id = quote_id));
create policy quote_lines_write on public.quote_lines for insert to authenticated
  with check (exists (select 1 from public.quotes q where q.id = quote_id and app.can_write_record(q.tenant_id, q.owner_id)));
create policy quote_lines_update on public.quote_lines for update to authenticated
  using (exists (select 1 from public.quotes q where q.id = quote_id and app.can_write_record(q.tenant_id, q.owner_id)));
create policy quote_lines_delete on public.quote_lines for delete to authenticated
  using (exists (select 1 from public.quotes q where q.id = quote_id and app.can_write_record(q.tenant_id, q.owner_id)));

create policy targets_read on public.forecast_targets for select to authenticated
  using (app.has_perm(tenant_id, 'crm.read_all') or owner_id = auth.uid() or (owner_id is null and app.is_member(tenant_id)));
create policy overrides_read on public.forecast_overrides for select to authenticated
  using (app.has_perm(tenant_id, 'crm.read_all') or owner_id = auth.uid());
create policy snapshots_read on public.forecast_snapshots for select to authenticated using (app.has_perm(tenant_id, 'crm.read_all'));
