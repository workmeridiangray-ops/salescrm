-- Outreach sequences: bounded email + task steps, approval before activation, suppression checked before
-- EVERY send, stop on reply / unsubscribe / opt-out / owner departure, daily caps and sending windows.
-- Opens and clicks are deliberately not tracked: they are weak signals and tracking pixels hurt trust.

insert into public.permissions (key, description) values
  ('sequences.manage',   'Build sequences and enrol contacts you can edit'),
  ('sequences.activate', 'Approve, pause and resume sequences; manage the suppression list');

create or replace function app.system_role_permissions(k text) returns text[] language sql immutable as $$
  select case k
    when 'staff' then array['crm.write', 'sequences.manage']
    when 'manager' then array['audit.view', 'crm.read_all', 'crm.write', 'forecast.manage', 'members.invite', 'members.view',
                              'pipeline.configure', 'products.manage', 'quotes.approve', 'records.reassign', 'sequences.activate', 'sequences.manage']
  end
$$;
update public.roles set permissions = app.system_role_permissions('staff') where is_system and key = 'staff';
update public.roles set permissions = app.system_role_permissions('manager') where is_system and key = 'manager';
update public.roles r set permissions = (select array_agg(key order by key) from public.permissions) where r.is_system and r.key = 'owner';

create table public.sequences (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 100),
  status text not null default 'draft' check (status in ('draft', 'active', 'paused')),
  daily_limit integer not null default 50 check (daily_limit between 1 and 500),
  window_start time not null default '09:00',
  window_end time not null default '18:00',
  tz text not null default 'Asia/Kolkata',
  created_by uuid default auth.uid(),
  activated_by uuid,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  check (window_start < window_end)
);

create table public.sequence_steps (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  sequence_id uuid not null,
  position integer not null check (position >= 0),
  kind text not null check (kind in ('email', 'task')),
  delay_days integer not null default 0 check (delay_days between 0 and 60),
  subject text not null check (length(trim(subject)) between 1 and 200),
  body text not null default '' check (length(body) <= 5000),
  unique (sequence_id, position) deferrable initially deferred,
  foreign key (tenant_id, sequence_id) references public.sequences (tenant_id, id) on delete cascade,
  check (kind <> 'email' or length(trim(body)) > 0)
);

create table public.enrolments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  sequence_id uuid not null,
  contact_id uuid not null,
  owner_id uuid not null,
  status text not null default 'active' check (status in ('active', 'completed', 'stopped')),
  stop_reason text check (stop_reason in ('replied', 'unsubscribed', 'opted_out', 'manual', 'owner_left', 'send_failed', 'contact_archived')),
  current_step integer not null default 0,
  next_step_at timestamptz not null,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  foreign key (tenant_id, sequence_id) references public.sequences (tenant_id, id) on delete cascade,
  foreign key (tenant_id, contact_id) references public.contacts (tenant_id, id),
  check ((status = 'stopped') = (stop_reason is not null))
);
create unique index enrolments_one_active on public.enrolments (sequence_id, contact_id) where status = 'active';
create index enrolments_due on public.enrolments (next_step_at) where status = 'active';

create table public.email_suppressions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  email text not null check (email = lower(email)),
  reason text not null check (reason in ('unsubscribed', 'bounced', 'complaint', 'manual')),
  created_at timestamptz not null default now(),
  unique (tenant_id, email)
);

create table public.outbound_emails (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  enrolment_id uuid not null references public.enrolments (id) on delete cascade,
  step_id uuid not null references public.sequence_steps (id),
  to_email text not null,
  subject text not null,
  body text not null,
  unsub_token_hash text not null unique,
  status text not null default 'sending' check (status in ('sending', 'sent', 'failed')),
  provider_message_id text,
  error text,
  queued_at timestamptz not null default now(),
  sent_at timestamptz
);
create index outbound_enrolment_idx on public.outbound_emails (enrolment_id, step_id);

create function app.render_template(tpl text, first_name text, company text) returns text language sql immutable as $$
  select replace(replace(tpl, '{{first_name}}', coalesce(nullif(first_name, ''), 'there')), '{{company}}', coalesce(nullif(company, ''), 'your company'))
$$;

-- Steps are frozen once a sequence has left draft, so people mid-flight never see the plan change underneath them.
create function app.sequence_steps_guard() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare sid uuid := coalesce(new.sequence_id, old.sequence_id);
begin
  if (select status from sequences where id = sid) <> 'draft' then raise exception 'sequence_locked'; end if;
  return coalesce(new, old);
end $$;
create trigger sequence_steps_guard before insert or update or delete on public.sequence_steps for each row execute function app.sequence_steps_guard();
create trigger lock_tenant before update on public.sequences for each row execute function app.lock_tenant_id();

-- Opting out or archiving a contact stops its sequences immediately.
create function app.contact_stops_sequences() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if (new.opted_out and not old.opted_out) or (new.archived_at is not null and old.archived_at is null) then
    update enrolments set status = 'stopped', stop_reason = case when new.opted_out and not old.opted_out then 'opted_out' else 'contact_archived' end, finished_at = now()
     where contact_id = new.id and status = 'active';
  end if;
  return null;
end $$;
create trigger contact_stops_sequences after update of opted_out, archived_at on public.contacts for each row execute function app.contact_stops_sequences();

-- ------------------------------------------------------------------ approval
create function public.set_sequence_status(p_sequence uuid, p_status text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare s sequences;
begin
  perform app.require_user();
  select * into s from sequences where id = p_sequence for update;
  if not found then raise exception 'sequence_not_found'; end if;
  perform app.require_perm(s.tenant_id, 'sequences.activate');
  if p_status not in ('active', 'paused') then raise exception 'invalid_request'; end if;
  if p_status = 'active' then
    if not exists (select 1 from sequence_steps where sequence_id = s.id) then raise exception 'sequence_empty'; end if;
    if (select kind from sequence_steps where sequence_id = s.id order by position limit 1) <> 'email' and not exists (select 1 from sequence_steps where sequence_id = s.id and kind = 'email') then
      raise exception 'sequence_needs_email';
    end if;
  elsif s.status = 'draft' then raise exception 'sequence_not_active'; end if;
  update sequences set status = p_status, activated_by = case when p_status = 'active' then auth.uid() else activated_by end where id = s.id;
  perform app.log(s.tenant_id, 'sequence.' || p_status, 'sequence', s.id::text, jsonb_build_object('name', s.name));
end $$;

-- ---------------------------------------------------------------- enrolment
-- Counts only; visible contacts only. Shown to the person before they confirm.
create function public.preview_enrolment(p_sequence uuid, p_contacts uuid[]) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare s sequences; r jsonb;
begin
  perform app.require_user();
  select * into s from sequences where id = p_sequence;
  if not found then raise exception 'sequence_not_found'; end if;
  perform app.require_perm(s.tenant_id, 'sequences.manage');
  select jsonb_build_object(
    'selected', count(*),
    'eligible', count(*) filter (where c.email is not null and not c.opted_out and sp.id is null and e.id is null),
    'no_email', count(*) filter (where c.email is null),
    'opted_out', count(*) filter (where c.opted_out),
    'suppressed', count(*) filter (where sp.id is not null),
    'already_enrolled', count(*) filter (where e.id is not null))
  into r
  from contacts c
  left join email_suppressions sp on sp.tenant_id = c.tenant_id and sp.email = c.email
  left join enrolments e on e.contact_id = c.id and e.sequence_id = p_sequence and e.status = 'active'
  where c.id = any (p_contacts) and c.tenant_id = s.tenant_id and c.archived_at is null and app.can_write_record(c.tenant_id, c.owner_id);
  return r;
end $$;

create function public.enrol_contacts(p_sequence uuid, p_contacts uuid[]) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare s sequences; n int; first_delay int;
begin
  perform app.require_user();
  select * into s from sequences where id = p_sequence;
  if not found then raise exception 'sequence_not_found'; end if;
  perform app.require_perm(s.tenant_id, 'sequences.manage');
  if s.status <> 'active' then raise exception 'sequence_not_active'; end if;
  if cardinality(p_contacts) > 500 then raise exception 'too_many_rows'; end if;
  select delay_days into first_delay from sequence_steps where sequence_id = s.id order by position limit 1;
  insert into enrolments (tenant_id, sequence_id, contact_id, owner_id, next_step_at)
  select c.tenant_id, s.id, c.id, auth.uid(), now() + make_interval(days => first_delay)
    from contacts c
   where c.id = any (p_contacts) and c.tenant_id = s.tenant_id and c.archived_at is null and c.email is not null and not c.opted_out
     and app.can_write_record(c.tenant_id, c.owner_id)
     and not exists (select 1 from email_suppressions x where x.tenant_id = c.tenant_id and x.email = c.email)
  on conflict (sequence_id, contact_id) where status = 'active' do nothing;
  get diagnostics n = row_count;
  perform app.log(s.tenant_id, 'sequence.enrolled', 'sequence', s.id::text, jsonb_build_object('count', n));
  return n;
end $$;

create function app.stop_for_contact(p_contact uuid, p_reason text) returns integer
language sql security definer set search_path = public, pg_temp as $$
  with s as (update enrolments set status = 'stopped', stop_reason = p_reason, finished_at = now() where contact_id = p_contact and status = 'active' returning 1)
  select count(*)::int from s
$$;

create function public.stop_enrolment(p_enrolment uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare e enrolments;
begin
  perform app.require_user();
  select * into e from enrolments where id = p_enrolment for update;
  if not found or not exists (select 1 from contacts c where c.id = e.contact_id and app.can_write_record(c.tenant_id, c.owner_id)) then raise exception 'enrolment_not_found'; end if;
  update enrolments set status = 'stopped', stop_reason = 'manual', finished_at = now() where id = p_enrolment and status = 'active';
end $$;

-- A reply stops EVERY active sequence for that contact and leaves a note on their timeline.
create function public.mark_replied(p_contact uuid) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare c contacts; n int;
begin
  perform app.require_user();
  select * into c from contacts where id = p_contact;
  if not found or not app.can_write_record(c.tenant_id, c.owner_id) then raise exception 'contact_not_found'; end if;
  n := app.stop_for_contact(p_contact, 'replied');
  insert into activities (tenant_id, kind, subject, contact_id, account_id, owner_id, done_at, outcome)
  values (c.tenant_id, 'email', 'Replied to outreach', c.id, c.account_id, auth.uid(), now(), 'Sequences stopped');
  perform app.log(c.tenant_id, 'sequence.replied', 'contact', c.id::text, jsonb_build_object('stopped', n));
  return n;
end $$;

-- Public one-click unsubscribe. Unknown tokens do nothing and say nothing.
create function public.unsubscribe(p_token text) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare o outbound_emails;
begin
  select * into o from outbound_emails where unsub_token_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'utf8')), 'hex');
  if not found then return false; end if;
  insert into email_suppressions (tenant_id, email, reason) values (o.tenant_id, o.to_email, 'unsubscribed') on conflict (tenant_id, email) do nothing;
  update enrolments set status = 'stopped', stop_reason = 'unsubscribed', finished_at = now()
   where status = 'active' and contact_id in (select id from contacts where tenant_id = o.tenant_id and email = o.to_email);
  update contacts set opted_out = true where tenant_id = o.tenant_id and email = o.to_email and not opted_out;   -- after, so the stop reason stays 'unsubscribed'
  perform app.log(o.tenant_id, 'sequence.unsubscribed', 'email', null, jsonb_build_object('email', o.to_email));
  return true;
end $$;

create function public.add_suppression(p_tenant uuid, p_email text, p_reason text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare mail text := lower(trim(p_email));
begin
  perform app.require_perm(p_tenant, 'sequences.activate');
  if p_reason not in ('bounced', 'complaint', 'manual') or position('@' in mail) < 2 then raise exception 'invalid_request'; end if;
  insert into email_suppressions (tenant_id, email, reason) values (p_tenant, mail, p_reason) on conflict (tenant_id, email) do nothing;
  update enrolments set status = 'stopped', stop_reason = 'opted_out', finished_at = now()
   where status = 'active' and contact_id in (select id from contacts where tenant_id = p_tenant and email = mail);
  perform app.log(p_tenant, 'suppression.added', 'email', null, jsonb_build_object('email', mail, 'reason', p_reason));
end $$;

create function public.sequence_stats(p_sequence uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare s sequences;
begin
  perform app.require_user();
  select * into s from sequences where id = p_sequence;
  if not found then raise exception 'sequence_not_found'; end if;
  perform app.require_perm(s.tenant_id, 'sequences.manage');
  return jsonb_build_object(
    'enrolled', (select count(*) from enrolments where sequence_id = p_sequence),
    'active', (select count(*) from enrolments where sequence_id = p_sequence and status = 'active'),
    'completed', (select count(*) from enrolments where sequence_id = p_sequence and status = 'completed'),
    'stopped', coalesce((select jsonb_object_agg(stop_reason, n) from (select stop_reason, count(*) n from enrolments where sequence_id = p_sequence and status = 'stopped' group by 1) x), '{}'::jsonb),
    'emails_sent', (select count(*) from outbound_emails o join enrolments e on e.id = o.enrolment_id where e.sequence_id = p_sequence and o.status = 'sent'),
    'emails_failed', (select count(*) from outbound_emails o join enrolments e on e.id = o.enrolment_id where e.sequence_id = p_sequence and o.status = 'failed'));
end $$;

-- ------------------------------------------------------- dispatcher (service)
create function public.sequence_claim_due(p_limit integer)
returns table (outbound_id bigint, to_email text, subject text, body text, unsub_token text, reply_to text)
language plpgsql security definer set search_path = public, pg_temp as $$
declare e enrolments; s sequences; st sequence_steps; c contacts; local_now timestamp; sent_today int; tok text; oid bigint; nxt sequence_steps; claimed int := 0; own_email text; lim int := greatest(1, least(coalesce(p_limit, 20), 50));
begin
  for e in
    select en.* from enrolments en join sequences sq on sq.id = en.sequence_id and sq.status = 'active'
      join tenants t on t.id = en.tenant_id and t.status <> 'suspended'
     where en.status = 'active' and en.next_step_at <= now() order by en.next_step_at limit lim * 4 for update of en skip locked
  loop
    exit when claimed >= lim;
    select * into s from sequences where id = e.sequence_id;
    select * into c from contacts where id = e.contact_id;
    -- Suppression is re-checked at EVERY send, not only when someone was enrolled.
    if c.archived_at is not null then update enrolments set status = 'stopped', stop_reason = 'contact_archived', finished_at = now() where id = e.id; continue; end if;
    if c.opted_out or (c.email is not null and exists (select 1 from email_suppressions x where x.tenant_id = c.tenant_id and x.email = c.email)) then
      update enrolments set status = 'stopped', stop_reason = case when c.opted_out then 'opted_out' else 'unsubscribed' end, finished_at = now() where id = e.id; continue;
    end if;
    if c.email is null then update enrolments set status = 'stopped', stop_reason = 'manual', finished_at = now() where id = e.id; continue; end if;
    if not exists (select 1 from memberships m where m.tenant_id = e.tenant_id and m.user_id = e.owner_id and m.status = 'active') then
      update enrolments set status = 'stopped', stop_reason = 'owner_left', finished_at = now() where id = e.id; continue;
    end if;
    select * into st from sequence_steps where sequence_id = e.sequence_id order by position offset e.current_step limit 1;
    if not found then update enrolments set status = 'completed', finished_at = now() where id = e.id; continue; end if;

    if st.kind = 'task' then
      insert into activities (tenant_id, kind, subject, body, due_at, contact_id, account_id, owner_id)
      values (e.tenant_id, 'task', app.render_template(st.subject, split_part(c.full_name, ' ', 1), null), nullif(st.body, ''), now(), c.id, c.account_id, e.owner_id);
    else
      local_now := now() at time zone s.tz;
      if local_now::time < s.window_start or local_now::time > s.window_end then continue; end if;   -- outside the sending window: try again later
      select count(*) into sent_today from outbound_emails o join enrolments x on x.id = o.enrolment_id
       where x.sequence_id = s.id and o.status in ('sending', 'sent') and (o.queued_at at time zone s.tz)::date = local_now::date;
      if sent_today >= s.daily_limit then continue; end if;                                          -- daily cap reached
      tok := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
      select p.email into own_email from profiles p where p.id = e.owner_id;
      insert into outbound_emails (tenant_id, enrolment_id, step_id, to_email, subject, body, unsub_token_hash)
      values (e.tenant_id, e.id, st.id, c.email,
              app.render_template(st.subject, split_part(c.full_name, ' ', 1), (select name from accounts where id = c.account_id)),
              app.render_template(st.body, split_part(c.full_name, ' ', 1), (select name from accounts where id = c.account_id)),
              encode(sha256(convert_to(tok, 'utf8')), 'hex')) returning id into oid;
      claimed := claimed + 1;
      outbound_id := oid; to_email := c.email; subject := (select o.subject from outbound_emails o where o.id = oid); body := (select o.body from outbound_emails o where o.id = oid);
      unsub_token := tok; reply_to := own_email;
      update enrolments set next_step_at = now() + interval '30 minutes' where id = e.id;           -- lease: no double send if the worker dies
      return next;
      continue;
    end if;
    -- task step finished: advance
    select * into nxt from sequence_steps where sequence_id = e.sequence_id order by position offset e.current_step + 1 limit 1;
    if found then update enrolments set current_step = e.current_step + 1, next_step_at = now() + make_interval(days => nxt.delay_days) where id = e.id;
    else update enrolments set status = 'completed', current_step = e.current_step + 1, finished_at = now() where id = e.id; end if;
  end loop;
end $$;

create function public.sequence_report_send(p_id bigint, p_ok boolean, p_message_id text, p_error text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare o outbound_emails; e enrolments; nxt sequence_steps; fails int;
begin
  select * into o from outbound_emails where id = p_id for update;
  if not found or o.status <> 'sending' then return; end if;
  select * into e from enrolments where id = o.enrolment_id for update;
  if p_ok then
    update outbound_emails set status = 'sent', sent_at = now(), provider_message_id = left(p_message_id, 200) where id = p_id;
    if e.status = 'active' then
      select * into nxt from sequence_steps where sequence_id = e.sequence_id order by position offset e.current_step + 1 limit 1;
      if found then update enrolments set current_step = e.current_step + 1, next_step_at = now() + make_interval(days => nxt.delay_days) where id = e.id;
      else update enrolments set status = 'completed', current_step = e.current_step + 1, finished_at = now() where id = e.id; end if;
    end if;
  else
    update outbound_emails set status = 'failed', error = left(p_error, 300) where id = p_id;
    select count(*) into fails from outbound_emails where enrolment_id = o.enrolment_id and step_id = o.step_id and status = 'failed';
    if e.status = 'active' then
      if fails >= 3 then update enrolments set status = 'stopped', stop_reason = 'send_failed', finished_at = now() where id = e.id;
      else update enrolments set next_step_at = now() + interval '15 minutes' where id = e.id; end if;
    end if;
  end if;
end $$;

-- Moving a person's records now moves their live sequences too (no orphaned, ownerless sends).
create or replace function public.reassign_records(p_tenant uuid, p_from uuid, p_to uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare a int; c int; l int; o int; t int; q int; sq int;
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
  update enrolments set owner_id = p_to where tenant_id = p_tenant and owner_id = p_from and status = 'active'; get diagnostics sq = row_count;
  perform app.log(p_tenant, 'records.reassigned', 'membership', p_from::text,
    jsonb_build_object('to', p_to, 'accounts', a, 'contacts', c, 'leads', l, 'opportunities', o, 'tasks', t, 'quotes', q, 'sequence_enrolments', sq));
  return jsonb_build_object('accounts', a, 'contacts', c, 'leads', l, 'opportunities', o, 'open_tasks', t, 'open_quotes', q, 'sequence_enrolments', sq);
end $$;

-- ------------------------------------------------------------ grants and RLS
revoke all on public.sequences, public.sequence_steps, public.enrolments, public.email_suppressions, public.outbound_emails from anon, authenticated;
revoke execute on function app.render_template(text, text, text), app.sequence_steps_guard(), app.contact_stops_sequences(), app.stop_for_contact(uuid, text),
  public.set_sequence_status(uuid, text), public.preview_enrolment(uuid, uuid[]), public.enrol_contacts(uuid, uuid[]), public.stop_enrolment(uuid),
  public.mark_replied(uuid), public.unsubscribe(text), public.add_suppression(uuid, text, text), public.sequence_stats(uuid),
  public.sequence_claim_due(integer), public.sequence_report_send(bigint, boolean, text, text), public.reassign_records(uuid, uuid, uuid) from public, anon;
grant execute on function public.set_sequence_status(uuid, text), public.preview_enrolment(uuid, uuid[]), public.enrol_contacts(uuid, uuid[]), public.stop_enrolment(uuid),
  public.mark_replied(uuid), public.add_suppression(uuid, text, text), public.sequence_stats(uuid), public.reassign_records(uuid, uuid, uuid) to authenticated;
grant execute on function public.unsubscribe(text) to anon, authenticated;
grant execute on function public.sequence_claim_due(integer), public.sequence_report_send(bigint, boolean, text, text) to service_role;

alter table public.sequences enable row level security;
alter table public.sequence_steps enable row level security;
alter table public.enrolments enable row level security;
alter table public.email_suppressions enable row level security;
alter table public.outbound_emails enable row level security;

grant select, insert on public.sequences to authenticated;
grant update (name, daily_limit, window_start, window_end, tz) on public.sequences to authenticated;
grant select, insert, update, delete on public.sequence_steps to authenticated;
grant select on public.enrolments, public.email_suppressions, public.outbound_emails to authenticated;

create policy sequences_read on public.sequences for select to authenticated using (app.has_perm(tenant_id, 'sequences.manage'));
create policy sequences_insert on public.sequences for insert to authenticated with check (app.has_perm(tenant_id, 'sequences.manage'));
create policy sequences_update on public.sequences for update to authenticated using (app.has_perm(tenant_id, 'sequences.manage')) with check (app.has_perm(tenant_id, 'sequences.manage'));
create policy steps_all on public.sequence_steps for all to authenticated using (app.has_perm(tenant_id, 'sequences.manage')) with check (app.has_perm(tenant_id, 'sequences.manage'));
create policy enrolments_read on public.enrolments for select to authenticated
  using (app.has_perm(tenant_id, 'sequences.manage') and (owner_id = auth.uid() or app.has_perm(tenant_id, 'crm.read_all')));
create policy suppressions_read on public.email_suppressions for select to authenticated using (app.has_perm(tenant_id, 'sequences.activate'));
create policy outbound_read on public.outbound_emails for select to authenticated
  using (app.has_perm(tenant_id, 'crm.read_all') and app.has_perm(tenant_id, 'sequences.manage'));
