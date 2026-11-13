-- Meetings and booking links. Double-booking is impossible at the database level (exclusion constraint that
-- includes the buffer), slots are recomputed on the server when someone books, and customers manage a booking
-- with an unguessable link. Calendar sync with Google/Microsoft is NOT part of this migration.

create extension if not exists btree_gist;

create table public.availability_rules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  user_id uuid not null default auth.uid(),
  weekday smallint not null check (weekday between 0 and 6),   -- 0 = Sunday, in the booking link's time zone
  start_time time not null,
  end_time time not null,
  check (start_time < end_time),
  foreign key (tenant_id, user_id) references public.memberships (tenant_id, user_id) on delete cascade
);

create table public.booking_links (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  owner_id uuid not null default auth.uid(),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{3,40}$'),
  title text not null check (length(trim(title)) between 1 and 100),
  duration_min smallint not null default 30 check (duration_min in (15, 30, 45, 60)),
  buffer_min smallint not null default 0 check (buffer_min between 0 and 60),
  notice_hours smallint not null default 4 check (notice_hours between 0 and 168),
  window_days smallint not null default 14 check (window_days between 1 and 60),
  tz text not null default 'Asia/Kolkata',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, owner_id) references public.memberships (tenant_id, user_id) on delete cascade
);

create table public.meetings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  owner_id uuid not null default auth.uid(),
  contact_id uuid,
  account_id uuid,
  opportunity_id uuid,
  title text not null check (length(trim(title)) between 1 and 160),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  buffer_min smallint not null default 0 check (buffer_min between 0 and 60),
  blocked_until timestamptz not null,
  status text not null default 'scheduled' check (status in ('scheduled', 'cancelled', 'completed', 'no_show')),
  attendee_name text,
  attendee_email text,
  notes text check (notes is null or length(notes) <= 2000),
  outcome text check (outcome is null or length(outcome) <= 1000),
  source text not null default 'manual' check (source in ('manual', 'booking')),
  booking_link_id uuid,
  manage_token_hash text unique,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  check (ends_at > starts_at),
  foreign key (tenant_id, contact_id) references public.contacts (tenant_id, id),
  foreign key (tenant_id, account_id) references public.accounts (tenant_id, id),
  foreign key (tenant_id, opportunity_id) references public.opportunities (tenant_id, id),
  foreign key (tenant_id, booking_link_id) references public.booking_links (tenant_id, id),
  foreign key (tenant_id, owner_id) references public.memberships (tenant_id, user_id) on delete cascade,
  -- one person cannot be in two scheduled meetings at once, buffers included
  constraint meetings_no_overlap exclude using gist (owner_id with =, tstzrange(starts_at, blocked_until) with &&) where (status = 'scheduled')
);
create index meetings_owner_time on public.meetings (tenant_id, owner_id, starts_at);

create function app.meetings_before() returns trigger language plpgsql as $$
begin
  new.blocked_until := new.ends_at + new.buffer_min * interval '1 minute';
  if tg_op = 'UPDATE' then
    if old.status <> 'scheduled' and (new.status is distinct from old.status or new.starts_at <> old.starts_at or new.ends_at <> old.ends_at) then
      raise exception 'meeting_closed';   -- finished meetings keep their history
    end if;
  end if;
  return new;
end $$;
create trigger meetings_before before insert or update on public.meetings for each row execute function app.meetings_before();
create trigger lock_tenant before update on public.meetings for each row execute function app.lock_tenant_id();

-- ---------------------------------------------------------------- availability
create function public.set_availability(p_tenant uuid, p_rules jsonb) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare r jsonb;
begin
  perform app.require_perm(p_tenant, 'crm.write');
  if jsonb_typeof(p_rules) <> 'array' or jsonb_array_length(p_rules) > 21 then raise exception 'invalid_request'; end if;
  delete from availability_rules where tenant_id = p_tenant and user_id = auth.uid();
  for r in select * from jsonb_array_elements(p_rules) loop
    insert into availability_rules (tenant_id, user_id, weekday, start_time, end_time)
    values (p_tenant, auth.uid(), (r ->> 'weekday')::smallint, (r ->> 'start')::time, (r ->> 'end')::time);
  end loop;
end $$;

-- Offered start times for a link. Pure computation over rules, notice, window and existing meetings.
create function app.slots_for(l booking_links, p_from timestamptz, p_to timestamptz) returns setof timestamptz
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare d date; ru availability_rules; s timestamptz; dur interval := l.duration_min * interval '1 minute'; earliest timestamptz := now() + l.notice_hours * interval '1 hour';
        latest timestamptz := now() + l.window_days * interval '1 day';
begin
  for d in select g::date from generate_series((p_from at time zone l.tz)::date, (p_to at time zone l.tz)::date, interval '1 day') g loop
    for ru in select * from availability_rules where tenant_id = l.tenant_id and user_id = l.owner_id and weekday = extract(dow from d)::int order by start_time loop
      s := (d + ru.start_time) at time zone l.tz;
      while s + dur <= (d + ru.end_time) at time zone l.tz loop
        if s >= earliest and s <= latest and s >= p_from and s < p_to
           and not exists (select 1 from meetings m where m.owner_id = l.owner_id and m.status = 'scheduled'
                            and tstzrange(m.starts_at, m.blocked_until) && tstzrange(s, s + dur + l.buffer_min * interval '1 minute')) then
          return next s;
        end if;
        s := s + dur;
      end loop;
    end loop;
  end loop;
end $$;

create function public.booking_slots(p_slug text, p_days integer default 14) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare l booking_links; t tenants;
begin
  select * into l from booking_links where slug = lower(trim(p_slug)) and active;
  if not found then return null; end if;
  select * into t from tenants where id = l.tenant_id and status <> 'suspended';
  if not found then return null; end if;
  return jsonb_build_object(
    'title', l.title, 'duration_min', l.duration_min, 'tz', l.tz, 'company', t.name,
    'host', (select coalesce(nullif(full_name, ''), 'Our team') from profiles where id = l.owner_id),
    'slots', coalesce((select jsonb_agg(x order by x) from app.slots_for(l, now(), now() + least(greatest(coalesce(p_days, 14), 1), l.window_days) * interval '1 day') x), '[]'::jsonb));
end $$;

-- Re-checks the slot on the server (never trusts the page), books it, links or creates the contact.
create function public.book_slot(p_slug text, p_starts timestamptz, p_name text, p_email text, p_notes text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare l booking_links; mail text := lower(trim(coalesce(p_email, ''))); cid uuid; aid uuid; mid uuid; tok text; ends timestamptz;
begin
  select * into l from booking_links where slug = lower(trim(p_slug)) and active;
  if not found or (select status from tenants where id = l.tenant_id) = 'suspended' then raise exception 'booking_unavailable'; end if;
  if length(trim(coalesce(p_name, ''))) = 0 or length(p_name) > 160 or position('@' in mail) < 2 or length(mail) > 200 or length(coalesce(p_notes, '')) > 1000 then raise exception 'invalid_request'; end if;
  if not exists (select 1 from app.slots_for(l, p_starts, p_starts + interval '1 minute') x where x = p_starts) then raise exception 'slot_taken'; end if;
  if (select count(*) from meetings where booking_link_id = l.id and attendee_email = mail and status = 'scheduled' and starts_at > now()) >= 3 then raise exception 'too_many_bookings'; end if;
  ends := p_starts + l.duration_min * interval '1 minute';
  select id, account_id into cid, aid from contacts where tenant_id = l.tenant_id and email = mail and archived_at is null limit 1;
  if cid is null then
    insert into contacts (tenant_id, full_name, email, source, owner_id) values (l.tenant_id, trim(p_name), mail, 'web', l.owner_id) returning id into cid;
  end if;
  tok := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  begin
    insert into meetings (tenant_id, owner_id, contact_id, account_id, title, starts_at, ends_at, buffer_min, attendee_name, attendee_email, notes, source, booking_link_id, manage_token_hash)
    values (l.tenant_id, l.owner_id, cid, aid, l.title, p_starts, ends, l.buffer_min, trim(p_name), mail, nullif(trim(coalesce(p_notes, '')), ''), 'booking', l.id, encode(sha256(convert_to(tok, 'utf8')), 'hex'))
    returning id into mid;
  exception when exclusion_violation then raise exception 'slot_taken';   -- someone else got there first
  end;
  insert into activities (tenant_id, kind, subject, contact_id, account_id, owner_id, done_at, outcome)
  values (l.tenant_id, 'meeting', 'Booked: ' || l.title, cid, aid, l.owner_id, now(), to_char(p_starts at time zone l.tz, 'DD Mon YYYY HH24:MI') || ' ' || l.tz);
  perform app.log(l.tenant_id, 'meeting.booked', 'meeting', mid::text, jsonb_build_object('email', mail));
  return jsonb_build_object('token', tok, 'starts_at', p_starts, 'ends_at', ends, 'tz', l.tz, 'title', l.title,
    'owner_email', (select email from profiles where id = l.owner_id), 'company', (select name from tenants where id = l.tenant_id));
end $$;

create function public.meeting_for_token(p_token text) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare m meetings; l booking_links;
begin
  select * into m from meetings where manage_token_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'utf8')), 'hex');
  if not found then return null; end if;
  select * into l from booking_links where id = m.booking_link_id;
  return jsonb_build_object('title', m.title, 'starts_at', m.starts_at, 'ends_at', m.ends_at, 'status', m.status, 'tz', l.tz, 'slug', l.slug,
    'company', (select name from tenants where id = m.tenant_id), 'can_cancel', m.status = 'scheduled' and m.starts_at > now());
end $$;

create function public.cancel_meeting_by_token(p_token text) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare m meetings;
begin
  select * into m from meetings where manage_token_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'utf8')), 'hex') for update;
  if not found or m.status <> 'scheduled' or m.starts_at <= now() then return false; end if;
  update meetings set status = 'cancelled' where id = m.id;
  insert into activities (tenant_id, kind, subject, contact_id, account_id, owner_id, done_at, outcome)
  values (m.tenant_id, 'meeting', 'Cancelled by attendee: ' || m.title, m.contact_id, m.account_id, m.owner_id, now(), 'Cancelled via link');
  perform app.log(m.tenant_id, 'meeting.cancelled_by_attendee', 'meeting', m.id::text);
  return true;
end $$;

-- ------------------------------------------------------------ grants and RLS
revoke all on public.availability_rules, public.booking_links, public.meetings from anon, authenticated;
revoke execute on function app.meetings_before(), app.slots_for(booking_links, timestamptz, timestamptz), public.set_availability(uuid, jsonb),
  public.booking_slots(text, integer), public.book_slot(text, timestamptz, text, text, text), public.meeting_for_token(text), public.cancel_meeting_by_token(text) from public, anon;
grant execute on function public.set_availability(uuid, jsonb) to authenticated;
grant execute on function public.booking_slots(text, integer), public.book_slot(text, timestamptz, text, text, text), public.meeting_for_token(text), public.cancel_meeting_by_token(text) to anon, authenticated;

alter table public.availability_rules enable row level security;
alter table public.booking_links enable row level security;
alter table public.meetings enable row level security;
grant select on public.availability_rules to authenticated;
grant select, insert on public.booking_links to authenticated;
grant update (title, duration_min, buffer_min, notice_hours, window_days, tz, active) on public.booking_links to authenticated;
grant select, insert on public.meetings to authenticated;
grant update (title, starts_at, ends_at, buffer_min, status, notes, outcome, contact_id, account_id, opportunity_id) on public.meetings to authenticated;

create policy availability_read on public.availability_rules for select to authenticated using (app.is_member(tenant_id) and (user_id = auth.uid() or app.has_perm(tenant_id, 'crm.read_all')));
create policy links_read on public.booking_links for select to authenticated using (app.can_read_record(tenant_id, owner_id));
create policy links_insert on public.booking_links for insert to authenticated with check (app.has_perm(tenant_id, 'crm.write') and owner_id = auth.uid());
create policy links_update on public.booking_links for update to authenticated using (owner_id = auth.uid() and app.has_perm(tenant_id, 'crm.write')) with check (owner_id = auth.uid());
create policy meetings_read on public.meetings for select to authenticated using (app.can_read_record(tenant_id, owner_id));
create policy meetings_insert on public.meetings for insert to authenticated with check (app.can_write_record(tenant_id, owner_id));
create policy meetings_update on public.meetings for update to authenticated using (app.can_write_record(tenant_id, owner_id)) with check (app.can_write_record(tenant_id, owner_id));
