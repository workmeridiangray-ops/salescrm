-- Row-level security. Clients may only SELECT (plus edit their own display
-- name); everything else is an RPC in 000200. Anything not granted is denied.
--
-- Access matrix                    member            needs permission
--   tenants        read            own workspaces    -
--   roles          read            own workspaces    -
--   memberships    read            own row           members.view for all
--   invitations    read            -                 members.invite
--   audit_log      read            -                 audit.view
--   profiles       read            self              members.view (people in that workspace)
--   permissions    read            everyone signed in

revoke all on all tables in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon;
revoke all on schema app from public, anon;
grant usage on schema app to authenticated;
revoke all on all functions in schema app from public, anon;

-- Policies call these helpers as the signed-in user.
grant execute on function app.caller_perms(uuid), app.is_member(uuid), app.has_perm(uuid, text),
  app.can_see_profile(uuid) to authenticated;

-- The RPC surface.
grant execute on function
  public.create_workspace(text, text), public.update_workspace(uuid, text),
  public.upsert_role(uuid, uuid, text, text, text[]), public.delete_role(uuid, uuid),
  public.invite_member(uuid, text, uuid), public.revoke_invitation(uuid, uuid), public.accept_invitation(text),
  public.change_member_role(uuid, uuid, uuid), public.set_member_status(uuid, uuid, text), public.remove_member(uuid, uuid)
  to authenticated;

alter table public.permissions enable row level security;
alter table public.tenants enable row level security;
alter table public.profiles enable row level security;
alter table public.roles enable row level security;
alter table public.memberships enable row level security;
alter table public.invitations enable row level security;
alter table public.audit_log enable row level security;

grant select on public.permissions, public.tenants, public.profiles, public.roles,
  public.memberships, public.invitations, public.audit_log to authenticated;
grant update (full_name) on public.profiles to authenticated;

create policy permissions_read on public.permissions for select to authenticated using (true);
create policy tenants_read on public.tenants for select to authenticated using (app.is_member(id));
create policy roles_read on public.roles for select to authenticated using (app.is_member(tenant_id));
create policy memberships_read on public.memberships for select to authenticated
  using (user_id = auth.uid() or app.has_perm(tenant_id, 'members.view'));
create policy invitations_read on public.invitations for select to authenticated
  using (app.has_perm(tenant_id, 'members.invite'));
create policy audit_read on public.audit_log for select to authenticated
  using (app.has_perm(tenant_id, 'audit.view'));
create policy profiles_read on public.profiles for select to authenticated using (app.can_see_profile(id));
create policy profiles_update_self on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());
