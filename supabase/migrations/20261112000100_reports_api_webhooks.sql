-- Reports (outcome-based, read through the caller's own RLS), saved views,
-- API keys with scopes and rate limits, outbound webhooks with a retry queue.

insert into public.permissions (key, description) values
  ('api.manage', 'Manage API keys and webhooks');
update public.roles r set permissions = (select array_agg(key order by key) from public.permissions) where r.is_system and r.key = 'owner';

-- ------------------------------------------------------------------- reports
-- All SECURITY INVOKER: staff see their own numbers, managers the workspace's.
create function public.report_lead_sources(p_tenant uuid, p_from date, p_to date)
returns table (source text, leads int, qualified int, converted int, disqualified int)
language sql stable set search_path = public, pg_temp as $$
  select l.source, count(*)::int,
         (count(*) filter (where l.status in ('qualified', 'converted')))::int,
         (count(*) filter (where l.status = 'converted'))::int,
         (count(*) filter (where l.status = 'disqualified'))::int
    from leads l where l.tenant_id = p_tenant and l.created_at::date between p_from and p_to
   group by l.source order by 2 desc, 1
$$;

-- How many opportunities ever entered each stage in the period.
create function public.report_funnel(p_tenant uuid, p_from date, p_to date)
returns table (stage text, stage_order int, kind text, entered int)
language sql stable set search_path = public, pg_temp as $$
  select s.name, s.position, s.kind, count(distinct h.opportunity_id)::int
    from stages s left join opportunity_history h on h.to_stage_id = s.id and h.at::date between p_from and p_to
   where s.tenant_id = p_tenant and s.pipeline_id = (select id from pipelines where tenant_id = p_tenant order by created_at limit 1)
   group by s.id, s.name, s.position, s.kind order by s.position
$$;

create function public.report_sales_cycle(p_tenant uuid, p_from date, p_to date)
returns table (owner_id uuid, won int, avg_days numeric, median_days numeric)
language sql stable set search_path = public, pg_temp as $$
  select o.owner_id, count(*)::int,
         round(avg(extract(epoch from (o.closed_at - o.created_at)) / 86400)::numeric, 1),
         round((percentile_cont(0.5) within group (order by extract(epoch from (o.closed_at - o.created_at)) / 86400))::numeric, 1)
    from opportunities o
   where o.tenant_id = p_tenant and o.status = 'won' and o.closed_at::date between p_from and p_to
   group by o.owner_id order by 2 desc
$$;

create function public.report_stage_ageing(p_tenant uuid)
returns table (stage text, stage_order int, open_deals int, avg_days numeric, max_days numeric)
language sql stable set search_path = public, pg_temp as $$
  select s.name, s.position, count(o.id)::int, round(avg(a.d)::numeric, 1), round(max(a.d)::numeric, 1)
    from stages s
    left join opportunities o on o.stage_id = s.id and o.status = 'open' and o.archived_at is null
    left join lateral (select extract(epoch from (now() - coalesce(max(h.at), o.created_at))) / 86400 as d
                         from opportunity_history h where h.opportunity_id = o.id and h.to_stage_id = o.stage_id) a on true
   where s.tenant_id = p_tenant and s.kind = 'open'
     and s.pipeline_id = (select id from pipelines where tenant_id = p_tenant order by created_at limit 1)
   group by s.id, s.name, s.position order by s.position
$$;

-- Outcomes first; completed activities are shown as context only, never as the score.
create function public.report_seller_performance(p_tenant uuid, p_from date, p_to date)
returns table (owner_id uuid, won_count int, won_amount numeric, lost_count int, open_amount numeric, no_next_action int, activities_done int)
language sql stable set search_path = public, pg_temp as $$
  select o.owner_id,
    (count(*) filter (where o.status = 'won' and o.closed_at::date between p_from and p_to))::int,
    coalesce(sum(o.amount) filter (where o.status = 'won' and o.closed_at::date between p_from and p_to), 0),
    (count(*) filter (where o.status = 'lost' and o.closed_at::date between p_from and p_to))::int,
    coalesce(sum(o.amount) filter (where o.status = 'open'), 0),
    (count(*) filter (where o.status = 'open' and o.next_action is null))::int,
    (select count(*)::int from activities a where a.tenant_id = p_tenant and a.owner_id is not distinct from o.owner_id and a.done_at::date between p_from and p_to)
  from opportunities o where o.tenant_id = p_tenant and o.archived_at is null
  group by o.owner_id order by 3 desc
$$;

create function public.report_losses(p_tenant uuid, p_from date, p_to date)
returns table (reason text, deals int, amount numeric)
language sql stable set search_path = public, pg_temp as $$
  select o.loss_reason, count(*)::int, coalesce(sum(o.amount), 0)
    from opportunities o where o.tenant_id = p_tenant and o.status = 'lost' and o.closed_at::date between p_from and p_to
   group by o.loss_reason order by 2 desc, 1
$$;

create table public.saved_views (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  user_id uuid not null default auth.uid(),
  report text not null check (report in ('lead_sources', 'funnel', 'sales_cycle', 'stage_ageing', 'seller_performance', 'losses')),
  name text not null check (length(trim(name)) between 1 and 80),
  params jsonb not null default '{}'::jsonb,
  shared boolean not null default false,
  created_at timestamptz not null default now(),
  unique (tenant_id, user_id, name)
);

-- ------------------------------------------------------------------ API keys
create table public.api_keys (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 80),
  key_prefix text not null,
  key_hash text not null unique,
  scopes text[] not null check (cardinality(scopes) > 0 and scopes <@ array['read:accounts', 'read:contacts', 'read:leads', 'read:opportunities', 'write:leads']),
  created_by uuid default auth.uid(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create table public.api_usage (
  key_id uuid not null references public.api_keys (id) on delete cascade,
  minute timestamptz not null,
  hits integer not null default 0,
  primary key (key_id, minute)
);

create function app.api_rate_limit() returns integer language sql immutable as $$ select 120 $$;

create function public.create_api_key(p_tenant uuid, p_name text, p_scopes text[]) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare k text; kid uuid;
begin
  perform app.require_perm(p_tenant, 'api.manage');
  k := 'sk_live_' || replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  insert into api_keys (tenant_id, name, key_prefix, key_hash, scopes)
  values (p_tenant, trim(p_name), left(k, 12), encode(sha256(convert_to(k, 'utf8')), 'hex'), p_scopes) returning id into kid;
  perform app.log(p_tenant, 'api_key.created', 'api_key', kid::text, jsonb_build_object('name', trim(p_name), 'scopes', p_scopes));
  return k;  -- the only time the key exists in clear
end $$;

create function public.revoke_api_key(p_tenant uuid, p_key uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.require_perm(p_tenant, 'api.manage');
  update api_keys set revoked_at = now() where id = p_key and tenant_id = p_tenant and revoked_at is null;
  if not found then raise exception 'api_key_not_found'; end if;
  perform app.log(p_tenant, 'api_key.revoked', 'api_key', p_key::text);
end $$;

-- Unknown, revoked and suspended-workspace keys all look the same from outside.
create function app.api_key_check(p_key text, p_scope text) returns api_keys
language plpgsql security definer set search_path = public, pg_temp as $$
declare k api_keys; n integer;
begin
  select * into k from api_keys where key_hash = encode(sha256(convert_to(coalesce(p_key, ''), 'utf8')), 'hex') and revoked_at is null;
  if not found or (select status from tenants where id = k.tenant_id) = 'suspended' then raise exception 'unauthorized'; end if;
  if not p_scope = any (k.scopes) then raise exception 'insufficient_scope'; end if;
  insert into api_usage (key_id, minute, hits) values (k.id, date_trunc('minute', now()), 1)
  on conflict (key_id, minute) do update set hits = api_usage.hits + 1 returning hits into n;
  if n > app.api_rate_limit() then raise exception 'rate_limited'; end if;
  if k.last_used_at is null or k.last_used_at < now() - interval '1 minute' then update api_keys set last_used_at = now() where id = k.id; end if;
  return k;
end $$;

create function public.api_list(p_key text, p_entity text, p_limit integer default 50, p_after uuid default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare k api_keys; lim integer := greatest(1, least(coalesce(p_limit, 50), 200)); v jsonb; nxt uuid;
begin
  if p_entity not in ('accounts', 'contacts', 'leads', 'opportunities') then raise exception 'unknown_entity'; end if;
  k := app.api_key_check(p_key, 'read:' || p_entity);
  if p_entity = 'accounts' then
    select coalesce(jsonb_agg(to_jsonb(r)), '[]') into v from (select id, name, domain, industry, source, created_at from accounts
      where tenant_id = k.tenant_id and archived_at is null and (p_after is null or id > p_after) order by id limit lim + 1) r;
  elsif p_entity = 'contacts' then
    select coalesce(jsonb_agg(to_jsonb(r)), '[]') into v from (select id, account_id, full_name, email, phone, job_title, opted_out, created_at from contacts
      where tenant_id = k.tenant_id and archived_at is null and (p_after is null or id > p_after) order by id limit lim + 1) r;
  elsif p_entity = 'leads' then
    select coalesce(jsonb_agg(to_jsonb(r)), '[]') into v from (select id, name, email, company, phone, source, status, score, created_at from leads
      where tenant_id = k.tenant_id and (p_after is null or id > p_after) order by id limit lim + 1) r;
  else
    select coalesce(jsonb_agg(to_jsonb(r)), '[]') into v from (select id, name, account_id, contact_id, amount, currency, status, kind, expected_close, created_at from opportunities
      where tenant_id = k.tenant_id and archived_at is null and (p_after is null or id > p_after) order by id limit lim + 1) r;
  end if;
  if jsonb_array_length(v) > lim then
    nxt := (v -> (lim - 1) ->> 'id')::uuid;
    select jsonb_agg(e order by i) into v from jsonb_array_elements(v) with ordinality t(e, i) where i <= lim;
  end if;
  return jsonb_build_object('data', v, 'next', nxt);
end $$;

create function public.api_create_lead(p_key text, p_name text, p_email text, p_company text, p_phone text, p_message text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare k api_keys;
begin
  k := app.api_key_check(p_key, 'write:leads');
  perform capture_lead((select slug from tenants where id = k.tenant_id), p_name, p_email, p_company, p_phone, p_message);  -- dedupes and assigns like the web form
end $$;

-- ----------------------------------------------------------------- webhooks
create table public.webhook_endpoints (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  url text not null check (url ~ '^https://[^\s/@]+(/[^\s]*)?$' and length(url) <= 500),
  secret text not null,   -- needed to sign deliveries; never granted to clients
  events text[] not null check (cardinality(events) > 0 and events <@ array['lead.created', 'opportunity.won', 'quote.accepted']),
  active boolean not null default true,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  unique (tenant_id, id)
);
create table public.webhook_deliveries (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  endpoint_id uuid not null references public.webhook_endpoints (id) on delete cascade,
  event text not null,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'delivered', 'dead')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  response_status integer,
  created_at timestamptz not null default now(),
  delivered_at timestamptz
);
create index webhook_due_idx on public.webhook_deliveries (next_attempt_at) where status = 'pending';

create function public.create_webhook(p_tenant uuid, p_url text, p_events text[]) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare s text := 'whsec_' || replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''); wid uuid;
begin
  perform app.require_perm(p_tenant, 'api.manage');
  if (select count(*) from webhook_endpoints where tenant_id = p_tenant) >= 10 then raise exception 'webhook_limit'; end if;
  insert into webhook_endpoints (tenant_id, url, secret, events) values (p_tenant, trim(p_url), s, p_events) returning id into wid;
  perform app.log(p_tenant, 'webhook.created', 'webhook', wid::text, jsonb_build_object('url', trim(p_url), 'events', p_events));
  return jsonb_build_object('id', wid, 'secret', s);
end $$;

create function public.set_webhook_active(p_tenant uuid, p_endpoint uuid, p_active boolean) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.require_perm(p_tenant, 'api.manage');
  update webhook_endpoints set active = p_active where id = p_endpoint and tenant_id = p_tenant;
  if not found then raise exception 'webhook_not_found'; end if;
  perform app.log(p_tenant, 'webhook.' || case when p_active then 'enabled' else 'disabled' end, 'webhook', p_endpoint::text);
end $$;

create function public.retry_delivery(p_tenant uuid, p_delivery bigint) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.require_perm(p_tenant, 'api.manage');
  update webhook_deliveries set status = 'pending', attempts = 0, next_attempt_at = now() where id = p_delivery and tenant_id = p_tenant and status = 'dead';
  if not found then raise exception 'delivery_not_retryable'; end if;
end $$;

create function app.enqueue_event(t uuid, ev text, payload jsonb) returns void
language sql security definer set search_path = public, pg_temp as $$
  insert into webhook_deliveries (tenant_id, endpoint_id, event, payload)
  select t, e.id, ev, jsonb_build_object('event', ev, 'workspace', (select slug from tenants where id = t), 'data', payload)
    from webhook_endpoints e where e.tenant_id = t and e.active and ev = any (e.events)
$$;

create function app.events_lead() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.enqueue_event(new.tenant_id, 'lead.created', jsonb_build_object('id', new.id, 'name', new.name, 'email', new.email, 'company', new.company, 'source', new.source, 'score', new.score));
  return null;
end $$;
create trigger events_lead after insert on public.leads for each row execute function app.events_lead();

create function app.events_opportunity() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.status = 'won' and old.status <> 'won' then
    perform app.enqueue_event(new.tenant_id, 'opportunity.won', jsonb_build_object('id', new.id, 'name', new.name, 'amount', new.amount, 'currency', new.currency, 'account_id', new.account_id));
  end if;
  return null;
end $$;
create trigger events_opportunity after update on public.opportunities for each row execute function app.events_opportunity();

create function app.events_quote() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.status = 'accepted' and old.status <> 'accepted' then
    perform app.enqueue_event(new.tenant_id, 'quote.accepted', jsonb_build_object('id', new.id, 'number', new.number, 'version', new.version, 'total', new.total, 'opportunity_id', new.opportunity_id));
  end if;
  return null;
end $$;
create trigger events_quote after update on public.quotes for each row execute function app.events_quote();

-- Dispatcher (service role only). A claim leases the delivery for 5 minutes so two workers never send the same one.
create function public.webhook_claim_batch(p_limit integer) returns table (id bigint, url text, secret text, event text, payload jsonb, attempts integer)
language sql security definer set search_path = public, pg_temp as $$
  with due as (
    select d.id from webhook_deliveries d
      join webhook_endpoints e on e.id = d.endpoint_id and e.active
      join tenants t on t.id = d.tenant_id and t.status <> 'suspended'
     where d.status = 'pending' and d.next_attempt_at <= now()
     order by d.next_attempt_at limit greatest(1, least(coalesce(p_limit, 20), 100)) for update of d skip locked)
  update webhook_deliveries d set next_attempt_at = now() + interval '5 minutes', attempts = d.attempts + 1
    from due, webhook_endpoints e where d.id = due.id and e.id = d.endpoint_id
  returning d.id, e.url, e.secret, d.event, d.payload, d.attempts
$$;

create function app.webhook_backoff(attempts integer) returns interval language sql immutable as $$
  select case attempts when 1 then interval '1 minute' when 2 then interval '5 minutes' when 3 then interval '30 minutes'
                       when 4 then interval '2 hours' else interval '12 hours' end
$$;

create function public.webhook_report(p_id bigint, p_ok boolean, p_http integer, p_error text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare d webhook_deliveries;
begin
  select * into d from webhook_deliveries where id = p_id for update;
  if not found or d.status <> 'pending' then return; end if;
  if p_ok then
    update webhook_deliveries set status = 'delivered', delivered_at = now(), response_status = p_http, last_error = null where id = p_id;
  elsif d.attempts >= 6 then
    update webhook_deliveries set status = 'dead', response_status = p_http, last_error = left(p_error, 300) where id = p_id;
  else
    update webhook_deliveries set next_attempt_at = now() + app.webhook_backoff(d.attempts), response_status = p_http, last_error = left(p_error, 300) where id = p_id;
  end if;
end $$;

-- ------------------------------------------------------------ grants and RLS
revoke all on public.saved_views, public.api_keys, public.api_usage, public.webhook_endpoints, public.webhook_deliveries from anon, authenticated;
revoke execute on function
  public.report_lead_sources(uuid, date, date), public.report_funnel(uuid, date, date), public.report_sales_cycle(uuid, date, date),
  public.report_stage_ageing(uuid), public.report_seller_performance(uuid, date, date), public.report_losses(uuid, date, date),
  public.create_api_key(uuid, text, text[]), public.revoke_api_key(uuid, uuid), app.api_key_check(text, text), app.api_rate_limit(),
  public.api_list(text, text, integer, uuid), public.api_create_lead(text, text, text, text, text, text),
  public.create_webhook(uuid, text, text[]), public.set_webhook_active(uuid, uuid, boolean), public.retry_delivery(uuid, bigint),
  app.enqueue_event(uuid, text, jsonb), app.events_lead(), app.events_opportunity(), app.events_quote(), app.webhook_backoff(integer),
  public.webhook_claim_batch(integer), public.webhook_report(bigint, boolean, integer, text) from public, anon;
grant execute on function
  public.report_lead_sources(uuid, date, date), public.report_funnel(uuid, date, date), public.report_sales_cycle(uuid, date, date),
  public.report_stage_ageing(uuid), public.report_seller_performance(uuid, date, date), public.report_losses(uuid, date, date),
  public.create_api_key(uuid, text, text[]), public.revoke_api_key(uuid, uuid),
  public.create_webhook(uuid, text, text[]), public.set_webhook_active(uuid, uuid, boolean), public.retry_delivery(uuid, bigint) to authenticated;
grant execute on function public.api_list(text, text, integer, uuid), public.api_create_lead(text, text, text, text, text, text) to anon, authenticated;
grant execute on function public.webhook_claim_batch(integer), public.webhook_report(bigint, boolean, integer, text) to service_role;
grant execute on function app.api_rate_limit() to authenticated;

alter table public.saved_views enable row level security;
alter table public.api_keys enable row level security;
alter table public.api_usage enable row level security;
alter table public.webhook_endpoints enable row level security;
alter table public.webhook_deliveries enable row level security;

grant select, insert, update, delete on public.saved_views to authenticated;
-- Column grants keep the key hash and the webhook secret away from clients.
grant select (id, tenant_id, name, key_prefix, scopes, created_by, last_used_at, revoked_at, created_at) on public.api_keys to authenticated;
grant select (id, tenant_id, url, events, active, created_at) on public.webhook_endpoints to authenticated;
grant select on public.webhook_deliveries to authenticated;

create policy saved_views_read on public.saved_views for select to authenticated using (app.is_member(tenant_id) and (user_id = auth.uid() or shared));
create policy saved_views_insert on public.saved_views for insert to authenticated with check (app.is_member(tenant_id) and user_id = auth.uid());
create policy saved_views_update on public.saved_views for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid() and app.is_member(tenant_id));
create policy saved_views_delete on public.saved_views for delete to authenticated using (user_id = auth.uid());
create policy api_keys_read on public.api_keys for select to authenticated using (app.has_perm(tenant_id, 'api.manage'));
create policy webhook_endpoints_read on public.webhook_endpoints for select to authenticated using (app.has_perm(tenant_id, 'api.manage'));
create policy webhook_deliveries_read on public.webhook_deliveries for select to authenticated using (app.has_perm(tenant_id, 'api.manage'));
