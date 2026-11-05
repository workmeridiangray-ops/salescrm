# Build plan

Source: "Sales CRM and Outreach SaaS - Full Scope" (INR 28,00,000, 32-42 weeks, estimate).
Numbers in brackets are section numbers of that document.

## Principles
- Every table has `tenant_id` and row-level security; branch and record-owner filters apply to lists, search, exports, reports and jobs [4, 20].
- Business rules live in small pure modules with their own tests.
- History is append-only: stage changes, amount changes, ownership, forecast snapshots [7, 13].
- Suppression is checked before every automated send, not only at enrolment [10].

## Phases
1. **Foundation**: auth, workspaces and switching, roles and permissions, audit log, tenant isolation tests [2, 4].
2. **Core CRM**: accounts, contacts, duplicate review and merge, CSV import/export, timeline [5, 16].
3. **Leads and pipeline**: lead capture and dedupe, assignment (owner rules, round robin), scoring, conversion, pipelines, stage rules, opportunity detail [6, 7].
4. **Seller workspace**: Today queue, tasks, call and meeting notes, reminders [8].
5. **Email, sequences, meetings**: one mailbox connector, sequences with preview and approval, opt-out and suppression, one calendar connector [9-11].
6. **Quotes and forecasts**: catalogue, quote builder, discount approvals, versions, forecast categories, overrides, period snapshots [12, 13].
7. **Territories and handover**: team tree, reassignment, won-deal handover, renewals [14, 15].
8. **SaaS operations**: plans, entitlements, subscription payments, platform super admin, support access, webhooks and API keys [3, 17, 18].
9. **Hardening**: accessibility, load targets, backup/restore, end-to-end acceptance [20].

## Open decisions (from the document)
Mailbox and calendar provider; per-user inbox vs team mailbox; payment provider and proration; currency/reporting method; retention and closure exports; numeric scale and recovery targets.

## Acceptance spine
Capture/import -> dedupe -> assign -> follow-up -> opportunity -> approved quote -> won -> handover, with complete history; reply/unsubscribe stops queued outreach.
