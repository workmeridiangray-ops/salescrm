-- Duplicate merge, stage/pipeline settings and templates, custom fields,
-- support-access grants, workspace closure and purge.

-- ===================================================================== merge
create function app.norm_name(n text) returns text language sql immutable as $$
  select trim(regexp_replace(regexp_replace(lower(coalesce(n, '')), '\m(pvt|private|ltd|limited|inc|llp|llc|co|company|corp)\M\.?', '', 'g'), '[^a-z0-9]+', ' ', 'g'))
$$;

-- Candidate pairs among records the caller can see (SECURITY INVOKER).
create function public.find_duplicates(p_tenant uuid, p_entity text)
returns table (a_id uuid, a_label text, b_id uuid, b_label text, reason text)
language plpgsql stable set search_path = public, pg_temp as $$
begin
  if p_entity = 'accounts' then
    return query
      select a.id, a.name, b.id, b.name,
             case when a.domain is not null and a.domain = b.domain then 'Same domain' else 'Similar name' end
        from accounts a join accounts b on b.tenant_id = a.tenant_id and b.id > a.id and b.archived_at is null
       where a.tenant_id = p_tenant and a.archived_at is null
         and ((a.domain is not null and a.domain = b.domain) or (app.norm_name(a.name) <> '' and app.norm_name(a.name) = app.norm_name(b.name)))
       order by 2, 4 limit 200;
  elsif p_entity = 'contacts' then
    return query
      select a.id, a.full_name, b.id, b.full_name,
             case when a.phone is not null and a.phone = b.phone then 'Same phone' else 'Same name and account' end
        from contacts a join contacts b on b.tenant_id = a.tenant_id and b.id > a.id and b.archived_at is null
       where a.tenant_id = p_tenant and a.archived_at is null
         and ((a.phone is not null and a.phone = b.phone)
              or (lower(a.full_name) = lower(b.full_name) and a.account_id is not distinct from b.account_id))
       order by 2, 4 limit 200;
  else
    raise exception 'invalid_request';
  end if;
end $$;

create table public.merge_log (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  entity text not null,
  kept_id uuid not null,
  removed_id uuid not null,
  removed_snapshot jsonb not null,
  actor_id uuid default auth.uid(),
  at timestamptz not null default now()
);
create trigger merge_log_immutable before update or delete on public.merge_log for each row execute function app.audit_log_immutable();

-- Field-by-field view of what a merge would do, so conflicts are visible before commit.
create function public.preview_merge(p_entity text, p_keep uuid, p_remove uuid) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare k jsonb; r jsonb; f text; out jsonb := '[]'::jsonb; fields text[];
begin
  if p_keep = p_remove then raise exception 'same_record'; end if;
  if p_entity = 'accounts' then
    select to_jsonb(a) into k from accounts a where id = p_keep; select to_jsonb(a) into r from accounts a where id = p_remove; fields := array['name', 'domain', 'industry'];
  elsif p_entity = 'contacts' then
    select to_jsonb(c) into k from contacts c where id = p_keep; select to_jsonb(c) into r from contacts c where id = p_remove; fields := array['full_name', 'email', 'phone', 'job_title', 'account_id'];
  else raise exception 'invalid_request'; end if;
  if k is null or r is null then raise exception 'record_not_found'; end if;
  foreach f in array fields loop
    out := out || jsonb_build_object('field', f, 'keep', k -> f, 'remove', r -> f,
      'conflict', (k -> f) is distinct from (r -> f) and (k -> f) <> 'null'::jsonb and (r -> f) <> 'null'::jsonb,
      'filled_from_removed', (k -> f) = 'null'::jsonb and (r -> f) <> 'null'::jsonb);
  end loop;
  return out;
end $$;

-- Keeps one record, moves every link to it, fills only EMPTY fields from the other, archives the other.
create function public.merge_records(p_entity text, p_keep uuid, p_remove uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare k record; r record; t uuid;
begin
  perform app.require_user();
  if p_keep = p_remove then raise exception 'same_record'; end if;
  if p_entity = 'accounts' then
    select * into k from accounts where id = p_keep and archived_at is null for update;
    select * into r from accounts where id = p_remove and archived_at is null for update;
    if k.id is null or r.id is null or k.tenant_id <> r.tenant_id then raise exception 'record_not_found'; end if;
    t := k.tenant_id;
    if not (app.can_read_record(t, k.owner_id) and app.can_read_record(t, r.owner_id)) then raise exception 'record_not_found'; end if;  -- never confirm records the caller can't see
    if not (app.can_write_record(t, k.owner_id) and app.can_write_record(t, r.owner_id)) then raise exception 'forbidden' using errcode = '42501'; end if;
    insert into merge_log (tenant_id, entity, kept_id, removed_id, removed_snapshot) values (t, p_entity, k.id, r.id, to_jsonb(r));
    update contacts set account_id = k.id where account_id = r.id;
    update opportunities set account_id = k.id where account_id = r.id;
    update activities set account_id = k.id where account_id = r.id;
    update handovers set account_id = k.id where account_id = r.id;
    update accounts set domain = coalesce(domain, r.domain), industry = coalesce(industry, r.industry) where id = k.id;
    update accounts set archived_at = now() where id = r.id;
  elsif p_entity = 'contacts' then
    select * into k from contacts where id = p_keep and archived_at is null for update;
    select * into r from contacts where id = p_remove and archived_at is null for update;
    if k.id is null or r.id is null or k.tenant_id <> r.tenant_id then raise exception 'record_not_found'; end if;
    t := k.tenant_id;
    if not (app.can_read_record(t, k.owner_id) and app.can_read_record(t, r.owner_id)) then raise exception 'record_not_found'; end if;  -- never confirm records the caller can't see
    if not (app.can_write_record(t, k.owner_id) and app.can_write_record(t, r.owner_id)) then raise exception 'forbidden' using errcode = '42501'; end if;
    insert into merge_log (tenant_id, entity, kept_id, removed_id, removed_snapshot) values (t, p_entity, k.id, r.id, to_jsonb(r));
    update opportunities set contact_id = k.id where contact_id = r.id;
    update activities set contact_id = k.id where contact_id = r.id;
    update handovers set contact_id = k.id where contact_id = r.id;
    update contacts set archived_at = now(), email = null where id = r.id;   -- frees the unique email before the keeper takes it
    update contacts set email = coalesce(email, r.email), phone = coalesce(phone, r.phone), job_title = coalesce(job_title, r.job_title),
                        account_id = coalesce(account_id, r.account_id), opted_out = opted_out or r.opted_out where id = k.id;
  else raise exception 'invalid_request'; end if;
  perform app.log(t, 'record.merged', p_entity, p_keep::text, jsonb_build_object('removed', p_remove));
end $$;

-- ====================================================== pipelines and stages
create function app.pipeline_owned(p_tenant uuid, p_pipeline uuid) returns void language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not exists (select 1 from pipelines where id = p_pipeline and tenant_id = p_tenant) then raise exception 'pipeline_not_found'; end if;
end $$;

create function public.create_pipeline(p_tenant uuid, p_name text, p_template text) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare pid uuid; spec jsonb; s jsonb; i int := 0;
begin
  perform app.require_perm(p_tenant, 'pipeline.configure');
  if (select count(*) from pipelines where tenant_id = p_tenant) >= 5 then raise exception 'pipeline_limit'; end if;
  spec := case p_template
    when 'blank' then '[["Qualification",10]]'
    when 'services' then '[["Discovery",10],["Proposal",40],["Negotiation",70]]'
    when 'distribution' then '[["Enquiry",10],["Quote sent",30],["PO expected",60]]'
    else null end::jsonb;
  if spec is null then raise exception 'invalid_request'; end if;
  insert into pipelines (tenant_id, name) values (p_tenant, trim(p_name)) returning id into pid;
  for s in select * from jsonb_array_elements(spec) loop
    insert into stages (tenant_id, pipeline_id, name, position, probability, kind) values (p_tenant, pid, s ->> 0, i, (s ->> 1)::int, 'open'); i := i + 1;
  end loop;
  insert into stages (tenant_id, pipeline_id, name, position, probability, kind) values (p_tenant, pid, 'Won', i, 100, 'won'), (p_tenant, pid, 'Lost', i + 1, 0, 'lost');
  perform app.log(p_tenant, 'pipeline.created', 'pipeline', pid::text, jsonb_build_object('template', p_template));
  return pid;
end $$;

create function public.add_stage(p_tenant uuid, p_pipeline uuid, p_name text, p_probability integer) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare n int; sid uuid;
begin
  perform app.require_perm(p_tenant, 'pipeline.configure');
  perform app.pipeline_owned(p_tenant, p_pipeline);
  if p_probability is null or p_probability < 1 or p_probability > 99 then raise exception 'invalid_probability'; end if;
  if (select count(*) from stages where pipeline_id = p_pipeline) >= 15 then raise exception 'stage_limit'; end if;
  select count(*) into n from stages where pipeline_id = p_pipeline and kind = 'open';
  set constraints all deferred;
  update stages set position = position + 1 where pipeline_id = p_pipeline and position >= n;
  insert into stages (tenant_id, pipeline_id, name, position, probability, kind) values (p_tenant, p_pipeline, trim(p_name), n, p_probability, 'open') returning id into sid;
  perform app.log(p_tenant, 'stage.added', 'stage', sid::text, jsonb_build_object('name', trim(p_name), 'probability', p_probability));
  return sid;
end $$;

create function public.update_stage(p_tenant uuid, p_stage uuid, p_name text, p_probability integer) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare s stages;
begin
  perform app.require_perm(p_tenant, 'pipeline.configure');
  select * into s from stages where id = p_stage and tenant_id = p_tenant;
  if not found then raise exception 'stage_not_found'; end if;
  if s.kind = 'open' and (p_probability is null or p_probability < 1 or p_probability > 99) then raise exception 'invalid_probability'; end if;
  update stages set name = trim(p_name), probability = case when kind = 'open' then p_probability else probability end where id = p_stage;
  perform app.log(p_tenant, 'stage.updated', 'stage', p_stage::text, jsonb_build_object('name', trim(p_name), 'probability', p_probability, 'was', s.probability));
end $$;

create function public.move_stage(p_tenant uuid, p_stage uuid, p_direction integer) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare s stages; o stages;
begin
  perform app.require_perm(p_tenant, 'pipeline.configure');
  select * into s from stages where id = p_stage and tenant_id = p_tenant;
  if not found or s.kind <> 'open' then raise exception 'stage_not_found'; end if;
  select * into o from stages where pipeline_id = s.pipeline_id and kind = 'open'
     and position = (select case when p_direction < 0 then max(position) else min(position) end from stages
                      where pipeline_id = s.pipeline_id and kind = 'open' and case when p_direction < 0 then position < s.position else position > s.position end);
  if not found then return; end if;
  set constraints all deferred;
  update stages set position = o.position where id = s.id;
  update stages set position = s.position where id = o.id;
end $$;

create function public.delete_stage(p_tenant uuid, p_stage uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare s stages;
begin
  perform app.require_perm(p_tenant, 'pipeline.configure');
  select * into s from stages where id = p_stage and tenant_id = p_tenant;
  if not found then raise exception 'stage_not_found'; end if;
  if s.kind <> 'open' then raise exception 'terminal_stage'; end if;
  if exists (select 1 from opportunities where stage_id = p_stage) then raise exception 'stage_in_use'; end if;
  if (select count(*) from stages where pipeline_id = s.pipeline_id and kind = 'open') <= 1 then raise exception 'last_open_stage'; end if;
  set constraints all deferred;
  delete from stages where id = p_stage;
  update stages set position = position - 1 where pipeline_id = s.pipeline_id and position > s.position;
  perform app.log(p_tenant, 'stage.deleted', 'stage', p_stage::text, jsonb_build_object('name', s.name));
end $$;

-- ================================================================ custom fields
create table public.custom_field_defs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  entity text not null check (entity in ('accounts', 'contacts', 'leads', 'opportunities')),
  key text not null check (key ~ '^[a-z][a-z0-9_]{1,30}$'),
  label text not null check (length(trim(label)) between 1 and 60),
  type text not null check (type in ('text', 'number', 'date', 'select', 'checkbox')),
  options text[] not null default '{}',
  required boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, entity, key),
  check (type <> 'select' or cardinality(options) between 1 and 30)
);
alter table public.accounts add column custom jsonb not null default '{}'::jsonb check (jsonb_typeof(custom) = 'object' and pg_column_size(custom) <= 8192);
alter table public.contacts add column custom jsonb not null default '{}'::jsonb check (jsonb_typeof(custom) = 'object' and pg_column_size(custom) <= 8192);
alter table public.leads add column custom jsonb not null default '{}'::jsonb check (jsonb_typeof(custom) = 'object' and pg_column_size(custom) <= 8192);
alter table public.opportunities add column custom jsonb not null default '{}'::jsonb check (jsonb_typeof(custom) = 'object' and pg_column_size(custom) <= 8192);

-- Values must match a defined field's type; required active fields must be present when the values change.
create function app.validate_custom() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare kv record; d custom_field_defs; ok boolean;
begin
  if tg_op = 'UPDATE' and new.custom is not distinct from old.custom then return new; end if;
  for kv in select key, value from jsonb_each(new.custom) loop
    select * into d from custom_field_defs where tenant_id = new.tenant_id and entity = tg_table_name and key = kv.key;
    if not found then raise exception 'custom_field_unknown: %', kv.key; end if;
    if kv.value = 'null'::jsonb then continue; end if;
    ok := case d.type
        when 'text' then jsonb_typeof(kv.value) = 'string' and length(kv.value #>> '{}') <= 500
        when 'number' then jsonb_typeof(kv.value) = 'number'
        when 'checkbox' then jsonb_typeof(kv.value) = 'boolean'
        when 'date' then jsonb_typeof(kv.value) = 'string' and (kv.value #>> '{}') ~ '^\d{4}-\d{2}-\d{2}$'
        when 'select' then jsonb_typeof(kv.value) = 'string' and (kv.value #>> '{}') = any (d.options)
      end;
    if not ok then raise exception 'custom_field_invalid: %', kv.key; end if;
  end loop;
  for d in select * from custom_field_defs where tenant_id = new.tenant_id and entity = tg_table_name and required and active loop
    if coalesce(new.custom -> d.key, 'null'::jsonb) in ('null'::jsonb, '""'::jsonb) then raise exception 'custom_field_required: %', d.key; end if;
  end loop;
  return new;
end $$;
create trigger validate_custom before insert or update on public.accounts for each row execute function app.validate_custom();
create trigger validate_custom before insert or update on public.contacts for each row execute function app.validate_custom();
create trigger validate_custom before insert or update on public.leads for each row execute function app.validate_custom();
create trigger validate_custom before insert or update on public.opportunities for each row execute function app.validate_custom();

create function public.create_custom_field(p_tenant uuid, p_entity text, p_key text, p_label text, p_type text, p_options text[], p_required boolean) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare id uuid;
begin
  perform app.require_perm(p_tenant, 'tenant.configure');
  if (select count(*) from custom_field_defs where tenant_id = p_tenant and entity = p_entity) >= 20 then raise exception 'custom_field_limit'; end if;
  insert into custom_field_defs (tenant_id, entity, key, label, type, options, required)
  values (p_tenant, p_entity, lower(trim(p_key)), trim(p_label), p_type, coalesce(p_options, '{}'), coalesce(p_required, false)) returning custom_field_defs.id into id;
  perform app.log(p_tenant, 'custom_field.created', 'custom_field', id::text, jsonb_build_object('entity', p_entity, 'key', lower(trim(p_key)), 'type', p_type));
  return id;
end $$;

create function public.set_custom_field_active(p_tenant uuid, p_field uuid, p_active boolean) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.require_perm(p_tenant, 'tenant.configure');
  update custom_field_defs set active = p_active where id = p_field and tenant_id = p_tenant;
  if not found then raise exception 'custom_field_not_found'; end if;
end $$;

-- =============================================================== support access
create table public.support_grants (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  granted_by uuid default auth.uid(),
  note text not null check (length(trim(note)) between 1 and 300),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create function public.grant_support_access(p_tenant uuid, p_hours integer, p_note text) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare id uuid;
begin
  perform app.require_perm(p_tenant, 'tenant.configure');
  if p_hours is null or p_hours < 1 or p_hours > 72 then raise exception 'invalid_request'; end if;
  insert into support_grants (tenant_id, note, expires_at) values (p_tenant, trim(p_note), now() + make_interval(hours => p_hours)) returning support_grants.id into id;
  perform app.log(p_tenant, 'support.access_granted', 'support_grant', id::text, jsonb_build_object('hours', p_hours, 'note', trim(p_note)));
  return id;
end $$;

create function public.revoke_support_access(p_tenant uuid, p_grant uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.require_perm(p_tenant, 'tenant.configure');
  update support_grants set revoked_at = now() where id = p_grant and tenant_id = p_tenant and revoked_at is null;
  if not found then raise exception 'grant_not_found'; end if;
  perform app.log(p_tenant, 'support.access_revoked', 'support_grant', p_grant::text);
end $$;

-- Counts and recent audit only (no customer records), and only while a grant is live. Every view is logged.
create function public.platform_support_summary(p_tenant uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare g support_grants;
begin
  if not app.is_platform(array['owner', 'support']) then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into g from support_grants where tenant_id = p_tenant and revoked_at is null and expires_at > now() order by expires_at desc limit 1;
  if not found then raise exception 'no_support_grant'; end if;
  perform app.log(p_tenant, 'support.summary_viewed', 'tenant', p_tenant::text, jsonb_build_object('grant', g.id));
  return jsonb_build_object(
    'grant_note', g.note, 'expires_at', g.expires_at,
    'members', (select count(*) from memberships where tenant_id = p_tenant),
    'accounts', (select count(*) from accounts where tenant_id = p_tenant),
    'leads', (select count(*) from leads where tenant_id = p_tenant),
    'opportunities', (select count(*) from opportunities where tenant_id = p_tenant),
    'pending_webhooks', (select count(*) from webhook_deliveries where tenant_id = p_tenant and status = 'pending'),
    'dead_webhooks', (select count(*) from webhook_deliveries where tenant_id = p_tenant and status = 'dead'),
    'recent_audit', coalesce((select jsonb_agg(jsonb_build_object('at', at, 'action', action, 'entity', entity) order by id desc)
                                from (select * from audit_log where tenant_id = p_tenant order by id desc limit 20) a), '[]'::jsonb));
end $$;

-- =========================================================== closure and purge
alter table public.tenants add column closure_requested_at timestamptz;

create function app.is_owner(t uuid) returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from memberships m join roles r on r.id = m.role_id
                  where m.tenant_id = t and m.user_id = auth.uid() and m.status = 'active' and r.key = 'owner')
$$;

-- The workspace stays fully usable (so data can be exported) for 30 days; the owner can cancel at any time.
create function public.request_closure(p_tenant uuid, p_confirm_slug text) returns timestamptz
language plpgsql security definer set search_path = public, pg_temp as $$
declare s text;
begin
  perform app.require_user();
  if not app.is_owner(p_tenant) then raise exception 'forbidden' using errcode = '42501'; end if;
  select slug into s from tenants where id = p_tenant;
  if lower(trim(coalesce(p_confirm_slug, ''))) <> s then raise exception 'confirmation_mismatch'; end if;
  update tenants set closure_requested_at = coalesce(closure_requested_at, now()) where id = p_tenant;
  perform app.log(p_tenant, 'workspace.closure_requested', 'tenant', p_tenant::text);
  return (select closure_requested_at + interval '30 days' from tenants where id = p_tenant);
end $$;

create function public.cancel_closure(p_tenant uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.require_user();
  if not app.is_owner(p_tenant) then raise exception 'forbidden' using errcode = '42501'; end if;
  update tenants set closure_requested_at = null where id = p_tenant and closure_requested_at is not null;
  if not found then raise exception 'no_closure_pending'; end if;
  perform app.log(p_tenant, 'workspace.closure_cancelled', 'tenant', p_tenant::text);
end $$;

-- Irreversible. Platform owners only; only workspaces whose 30 days have passed. The audit trail is kept.
create function public.platform_purge_closed() returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare r record; n integer := 0;
begin
  if not app.is_platform(array['owner']) then raise exception 'forbidden' using errcode = '42501'; end if;
  for r in select id, slug from tenants where closure_requested_at < now() - interval '30 days' loop
    perform app.log(r.id, 'platform.purged', 'tenant', r.id::text, jsonb_build_object('slug', r.slug));
    delete from tenants where id = r.id;
    n := n + 1;
  end loop;
  return n;
end $$;

-- ============================================================= grants and RLS
revoke all on public.merge_log, public.custom_field_defs, public.support_grants from anon, authenticated;
revoke execute on function
  app.norm_name(text), app.pipeline_owned(uuid, uuid), app.validate_custom(), app.is_owner(uuid),
  public.find_duplicates(uuid, text), public.preview_merge(text, uuid, uuid), public.merge_records(text, uuid, uuid),
  public.create_pipeline(uuid, text, text), public.add_stage(uuid, uuid, text, integer), public.update_stage(uuid, uuid, text, integer),
  public.move_stage(uuid, uuid, integer), public.delete_stage(uuid, uuid),
  public.create_custom_field(uuid, text, text, text, text, text[], boolean), public.set_custom_field_active(uuid, uuid, boolean),
  public.grant_support_access(uuid, integer, text), public.revoke_support_access(uuid, uuid), public.platform_support_summary(uuid),
  public.request_closure(uuid, text), public.cancel_closure(uuid), public.platform_purge_closed() from public, anon;
grant execute on function app.norm_name(text), app.is_owner(uuid) to authenticated;
grant execute on function
  public.find_duplicates(uuid, text), public.preview_merge(text, uuid, uuid), public.merge_records(text, uuid, uuid),
  public.create_pipeline(uuid, text, text), public.add_stage(uuid, uuid, text, integer), public.update_stage(uuid, uuid, text, integer),
  public.move_stage(uuid, uuid, integer), public.delete_stage(uuid, uuid),
  public.create_custom_field(uuid, text, text, text, text, text[], boolean), public.set_custom_field_active(uuid, uuid, boolean),
  public.grant_support_access(uuid, integer, text), public.revoke_support_access(uuid, uuid), public.platform_support_summary(uuid),
  public.request_closure(uuid, text), public.cancel_closure(uuid), public.platform_purge_closed() to authenticated;

alter table public.merge_log enable row level security;
alter table public.custom_field_defs enable row level security;
alter table public.support_grants enable row level security;
grant select on public.merge_log, public.custom_field_defs, public.support_grants to authenticated;
create policy merge_log_read on public.merge_log for select to authenticated using (app.has_perm(tenant_id, 'crm.read_all'));
create policy custom_defs_read on public.custom_field_defs for select to authenticated using (app.is_member(tenant_id));
create policy support_grants_read on public.support_grants for select to authenticated using (app.has_perm(tenant_id, 'tenant.configure'));
-- accounts/contacts/leads/opportunities already allow update of every column; `custom` is covered by their update policies.
