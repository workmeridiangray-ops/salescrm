/**
 * Permission catalogue and role rules. Mirrors the SQL in
 * supabase/migrations (parity.test.ts fails if the two drift). The database
 * is the enforcement point; this module drives what the UI offers.
 */
export const PERMISSIONS = {
  "members.view": "View the member directory",
  "members.invite": "Invite people and revoke invitations",
  "members.manage": "Change roles, suspend, reinstate and remove members",
  "roles.manage": "Create, edit and delete roles",
  "audit.view": "Read the audit trail",
  "tenant.configure": "Change workspace settings",
  "crm.read_all": "See every account, contact, lead and opportunity in the workspace",
  "crm.write": "Create and edit records you own",
  "pipeline.configure": "Configure pipelines and stages",
  "crm.export": "Export records",
  "billing.manage": "Manage the subscription and payment details",
  "quotes.approve": "Approve discounted quotes and revise accepted ones",
  "forecast.manage": "Set targets, adjust forecasts and take snapshots",
  "products.manage": "Manage the product catalogue",
} as const;
export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

export const SYSTEM_ROLES: Record<"owner" | "manager" | "staff", { name: string; permissions: Permission[] }> = {
  owner: { name: "Owner", permissions: [...ALL_PERMISSIONS].sort() },
  manager: {
    name: "Manager",
    permissions: ["audit.view", "crm.read_all", "crm.write", "forecast.manage", "members.invite", "members.view", "pipeline.configure", "products.manage", "quotes.approve"],
  },
  staff: { name: "Staff", permissions: ["crm.write"] },
};

export const can = (held: readonly string[], p: Permission) => held.includes(p);

/** You may only hand out, edit or take away power you hold yourself. */
export const holdsAll = (held: readonly string[], wanted: readonly string[]) => wanted.every((p) => held.includes(p));

export function isPermission(x: string): x is Permission {
  return Object.prototype.hasOwnProperty.call(PERMISSIONS, x);
}

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

/** Map a database error message to a sentence for the user. */
export const ERROR_TEXT: Record<string, string> = {
  forbidden: "You don't have permission to do that.",
  not_signed_in: "Please sign in again.",
  last_owner: "A workspace must keep at least one active owner.",
  cannot_grant_unheld_permission: "You can only grant permissions you hold yourself.",
  cannot_edit_more_powerful_role: "You can't edit a role that is more powerful than yours.",
  cannot_act_on_more_powerful_member: "You can't change someone who has more access than you.",
  system_role_locked: "Built-in roles can't be changed.",
  role_in_use: "That role is still assigned. Move its members or invitations first.",
  role_not_found: "That role no longer exists.",
  member_not_found: "That person is not in this workspace.",
  unknown_permission: "Unknown permission.",
  already_a_member: "That person is already a member.",
  already_invited: "That address already has a pending invitation.",
  invitation_invalid: "This invitation link isn't valid for your account. Sign in with the invited email address.",
  invitation_revoked: "This invitation was withdrawn. Ask for a new one.",
  invitation_expired: "This invitation has expired. Ask for a new one.",
  invitation_used: "This invitation has already been used.",
  workspace_suspended: "This workspace is suspended.",
  owner_not_member: "The owner must be an active member of this workspace.",
  loss_reason_required: "Say why the deal was lost.",
  lead_not_found: "That lead no longer exists.",
  lead_already_converted: "That lead was already converted.",
  lead_disqualified: "Disqualified leads can't be converted. Reopen the lead first.",
  plan_limit_users: "Your plan's user limit is reached. Upgrade the plan to invite more people.",
  reason_required: "Give a reason. It is recorded in the audit trail.",
  workspace_not_found: "That workspace no longer exists.",
  invalid_request: "Please check the details and try again.",
  quote_locked: "This quote can't be edited any more. Create a revision instead.",
  quote_empty: "Add at least one line before submitting.",
  quote_not_draft: "Only draft quotes can be submitted.",
  quote_not_pending: "That quote isn't waiting for approval.",
  quote_not_approved: "Only approved quotes can be sent.",
  quote_not_revisable: "Draft quotes are edited directly; superseded ones can't be revised.",
  quote_expired: "This quote has expired. Revise it to set a new validity date.",
  quote_not_found: "That quote no longer exists.",
  quote_already_answered: "This quote has already been answered.",
  self_approval: "You can't approve your own quote. Ask another approver.",
  revision_needs_approval: "Revising an accepted quote needs a quote approver.",
  opportunity_not_found: "That opportunity no longer exists.",
  name_required: "Please enter your name.",
  invitation_not_pending: "That invitation is no longer pending.",
};

export function friendlyError(message: string | undefined): string {
  if (!message) return "Something went wrong. Please try again.";
  if (ERROR_TEXT[message]) return ERROR_TEXT[message]!;
  if (/duplicate key.*slug/.test(message)) return "That workspace address is taken.";
  if (/duplicate key.*\(tenant_id, key\)/.test(message)) return "A role with that key already exists.";
  if (/accounts_name_unique/.test(message)) return "An account with that name already exists.";
  if (/contacts_email_unique|leads_email_open/.test(message)) return "A record with that email already exists.";
  if (/violates row-level security/.test(message)) return "You can only change records you own.";
  if (/tenants_slug_check/.test(message)) return "Use 3–40 lowercase letters, numbers or hyphens for the address.";
  return "Something went wrong. Please try again.";
}
