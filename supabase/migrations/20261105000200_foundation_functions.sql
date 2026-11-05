-- Helpers (schema app) used by policies, and RPCs (schema public) that are the
-- only way to change tenant data. All are SECURITY DEFINER with a pinned
-- search_path and check the caller themselves.

create function app.caller_perms(t uuid) returns text[]
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select r.permissions
       from memberships m
       join roles r on r.id = m.role_id and r.tenant_id = m.tenant_id
       join tenants tn on tn.id = m.tenant_id
      where m.tenant_id = t and m.user_id = auth.uid()
        and m.status = 'active' and tn.status <> 'suspended'),
    '{}')
$$;

create function app.is_member(t uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from memberships m
                  where m.tenant_id = t and m.user_id = auth.uid() and m.status = 'active')
$$;

create function app.has_perm(t uuid, p text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select p = any (app.caller_perms(t))
$$;

-- Can the caller see this person's profile? Self, or a member of a tenant
-- where the caller may view the member directory.
create function app.can_see_profile(p uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select p = auth.uid() or exists (
    select 1 from memberships m
     where m.user_id = p and app.has_perm(m.tenant_id, 'members.view'))
$$;

create function app.log(t uuid, p_action text, p_entity text, p_entity_id text, p_detail jsonb default '{}')
returns void language sql security definer set search_path = public, pg_temp as $$
  insert into audit_log (tenant_id, actor_id, action, entity, entity_id, detail)
  values (t, auth.uid(), p_action, p_entity, p_entity_id, coalesce(p_detail, '{}'))
$$;

create function app.require_user() returns uuid language plpgsql stable as $$
begin
  if auth.uid() is null then raise exception 'not_signed_in' using errcode = '28000'; end if;
  return auth.uid();
end $$;

create function app.require_perm(t uuid, p text) returns void language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform app.require_user();
  if not app.has_perm(t, p) then raise exception 'forbidden' using errcode = '42501'; end if;
end $$;

-- Another active owner exists besides `except_user`.
create function app.has_other_owner(t uuid, except_user uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from memberships m join roles r on r.id = m.role_id
                  where m.tenant_id = t and r.key = 'owner' and m.status = 'active' and m.user_id <> except_user)
$$;

-- ---------------------------------------------------------------- workspaces
create function public.create_workspace(p_name text, p_slug text) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare tid uuid; owner_role uuid; me uuid := app.require_user();
begin
  insert into tenants (name, slug) values (trim(p_name), lower(trim(p_slug))) returning id into tid;
  insert into roles (tenant_id, key, name, permissions, is_system) values
    (tid, 'staff',   'Staff',   '{}', true),
    (tid, 'manager', 'Manager', array['members.view', 'members.invite', 'audit.view'], true);
  insert into roles (tenant_id, key, name, permissions, is_system)
    select tid, 'owner', 'Owner', array_agg(key order by key), true from permissions
    returning id into owner_role;
  insert into memberships (tenant_id, user_id, role_id) values (tid, me, owner_role);
  perform app.log(tid, 'workspace.created', 'tenant', tid::text, jsonb_build_object('slug', lower(trim(p_slug))));
  return tid;
end $$;

create function public.update_workspace(p_tenant uuid, p_name text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.require_perm(p_tenant, 'tenant.configure');
  update tenants set name = trim(p_name) where id = p_tenant;
  perform app.log(p_tenant, 'workspace.renamed', 'tenant', p_tenant::text, jsonb_build_object('name', trim(p_name)));
end $$;

-- --------------------------------------------------------------------- roles
-- Escalation guard used throughout: you may only hand out, edit or take away
-- power you hold yourself.
create function app.holds_all(t uuid, perms text[]) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select perms <@ app.caller_perms(t)
$$;

create function public.upsert_role(p_tenant uuid, p_role uuid, p_key text, p_name text, p_perms text[]) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare existing roles; rid uuid; perms text[] := coalesce(p_perms, '{}');
begin
  perform app.require_perm(p_tenant, 'roles.manage');
  if exists (select 1 from unnest(perms) x where x not in (select key from permissions)) then
    raise exception 'unknown_permission';
  end if;
  if not app.holds_all(p_tenant, perms) then raise exception 'cannot_grant_unheld_permission' using errcode = '42501'; end if;
  if p_role is null then
    insert into roles (tenant_id, key, name, permissions)
    values (p_tenant, lower(trim(p_key)), trim(p_name), (select coalesce(array_agg(distinct x order by x), '{}') from unnest(perms) x))
    returning id into rid;
    perform app.log(p_tenant, 'role.created', 'role', rid::text, jsonb_build_object('key', lower(trim(p_key)), 'permissions', perms));
  else
    select * into existing from roles where id = p_role and tenant_id = p_tenant for update;
    if not found then raise exception 'role_not_found'; end if;
    if existing.is_system then raise exception 'system_role_locked'; end if;
    if not app.holds_all(p_tenant, existing.permissions) then raise exception 'cannot_edit_more_powerful_role' using errcode = '42501'; end if;
    update roles set name = trim(p_name),
           permissions = (select coalesce(array_agg(distinct x order by x), '{}') from unnest(perms) x)
     where id = p_role;
    rid := p_role;
    perform app.log(p_tenant, 'role.updated', 'role', rid::text,
      jsonb_build_object('before', existing.permissions, 'after', perms));
  end if;
  return rid;
end $$;

create function public.delete_role(p_tenant uuid, p_role uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare existing roles;
begin
  perform app.require_perm(p_tenant, 'roles.manage');
  select * into existing from roles where id = p_role and tenant_id = p_tenant;
  if not found then raise exception 'role_not_found'; end if;
  if existing.is_system then raise exception 'system_role_locked'; end if;
  if exists (select 1 from memberships where role_id = p_role) or exists (select 1 from invitations where role_id = p_role and status = 'pending') then
    raise exception 'role_in_use';
  end if;
  delete from roles where id = p_role;
  perform app.log(p_tenant, 'role.deleted', 'role', p_role::text, jsonb_build_object('key', existing.key));
end $$;

-- -------------------------------------------------------------- invitations
create function public.invite_member(p_tenant uuid, p_email text, p_role uuid) returns text
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
  tok := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  insert into invitations (tenant_id, email, role_id, token_hash, invited_by, expires_at)
  values (p_tenant, mail, p_role, encode(sha256(convert_to(tok, 'utf8')), 'hex'), auth.uid(), now() + interval '7 days')
  returning id into iid;
  perform app.log(p_tenant, 'invitation.created', 'invitation', iid::text, jsonb_build_object('email', mail, 'role', r.key));
  return tok;
end $$;

create function public.revoke_invitation(p_tenant uuid, p_invitation uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  perform app.require_perm(p_tenant, 'members.invite');
  update invitations set status = 'revoked', resolved_at = now()
   where id = p_invitation and tenant_id = p_tenant and status = 'pending';
  get diagnostics n = row_count;
  if n = 0 then raise exception 'invitation_not_pending'; end if;
  perform app.log(p_tenant, 'invitation.revoked', 'invitation', p_invitation::text);
end $$;

-- Distinct outcomes: wrong person / unknown token -> invitation_invalid
-- (indistinguishable on purpose); then revoked, expired, already used.
create function public.accept_invitation(p_token text) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare inv invitations; me uuid := app.require_user(); my_email text;
begin
  select email into my_email from profiles where id = me;
  select * into inv from invitations where token_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'utf8')), 'hex') for update;
  if not found or inv.email <> my_email then raise exception 'invitation_invalid'; end if;
  if inv.status = 'revoked' then raise exception 'invitation_revoked'; end if;
  if inv.status = 'accepted' then raise exception 'invitation_used'; end if;
  if inv.expires_at < now() then raise exception 'invitation_expired'; end if;
  if (select status from tenants where id = inv.tenant_id) = 'suspended' then raise exception 'workspace_suspended'; end if;
  insert into memberships (tenant_id, user_id, role_id) values (inv.tenant_id, me, inv.role_id)
    on conflict (tenant_id, user_id) do nothing;
  update invitations set status = 'accepted', resolved_at = now() where id = inv.id;
  perform app.log(inv.tenant_id, 'invitation.accepted', 'invitation', inv.id::text);
  return inv.tenant_id;
end $$;

-- ------------------------------------------------------------------ members
-- Shared guard for acting on another membership.
create function app.guard_member_change(p_tenant uuid, p_user uuid, out target memberships, out target_role roles)
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.require_perm(p_tenant, 'members.manage');
  select * into target from memberships where tenant_id = p_tenant and user_id = p_user for update;
  if not found then raise exception 'member_not_found'; end if;
  select * into target_role from roles where id = target.role_id;
  -- You cannot act on someone more powerful than you (e.g. a manager on an owner).
  if not app.holds_all(p_tenant, target_role.permissions) then
    raise exception 'cannot_act_on_more_powerful_member' using errcode = '42501';
  end if;
end $$;

create function public.change_member_role(p_tenant uuid, p_user uuid, p_role uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare g record; newr roles;
begin
  select * into g from app.guard_member_change(p_tenant, p_user);
  select * into newr from roles where id = p_role and tenant_id = p_tenant;
  if not found then raise exception 'role_not_found'; end if;
  if not app.holds_all(p_tenant, newr.permissions) then raise exception 'cannot_grant_unheld_permission' using errcode = '42501'; end if;
  if (g.target_role).key = 'owner' and newr.key <> 'owner' and (g.target).status = 'active'
     and not app.has_other_owner(p_tenant, p_user) then
    raise exception 'last_owner';
  end if;
  update memberships set role_id = p_role where tenant_id = p_tenant and user_id = p_user;
  perform app.log(p_tenant, 'member.role_changed', 'membership', p_user::text,
    jsonb_build_object('from', (g.target_role).key, 'to', newr.key));
end $$;

-- Takes effect immediately for all tenant data: policies read membership live.
create function public.set_member_status(p_tenant uuid, p_user uuid, p_status text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare g record;
begin
  if p_status not in ('active', 'suspended') then raise exception 'invalid_status'; end if;
  select * into g from app.guard_member_change(p_tenant, p_user);
  if p_status = 'suspended' and (g.target_role).key = 'owner' and not app.has_other_owner(p_tenant, p_user) then
    raise exception 'last_owner';
  end if;
  update memberships set status = p_status where tenant_id = p_tenant and user_id = p_user;
  perform app.log(p_tenant, 'member.' || case p_status when 'suspended' then 'suspended' else 'reinstated' end,
    'membership', p_user::text);
end $$;

create function public.remove_member(p_tenant uuid, p_user uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare g record;
begin
  select * into g from app.guard_member_change(p_tenant, p_user);
  if (g.target_role).key = 'owner' and not app.has_other_owner(p_tenant, p_user) then raise exception 'last_owner'; end if;
  delete from memberships where tenant_id = p_tenant and user_id = p_user;
  perform app.log(p_tenant, 'member.removed', 'membership', p_user::text, jsonb_build_object('role', (g.target_role).key));
end $$;
