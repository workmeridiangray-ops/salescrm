# Sales CRM and Outreach SaaS

Multi-tenant CRM for B2B teams, distributors, agencies and service businesses:
accounts, contacts, lead intake, opportunities, outreach sequences, meetings,
quotations, forecasting and sales handover. Each subscribing company is isolated.

**Status: foundation, core CRM, leads/pipeline, marketing site, plans and trials, Razorpay billing, Brevo email and platform admin are built; quotes (catalogue, GST, approvals, customer review link, revisions) and forecasting (targets, adjustments, snapshots) are built; teams, reassignment, won-deal handover, renewals and CSV import/export are built; reports, API keys, webhooks, duplicate merge, stage settings and templates, custom fields, two-step sign-in, support-access grants and workspace closure are built; outreach sequences, meetings and booking pages, scheduled report emails and lead territory rules are built; Google mailbox/calendar sync, coupons/refunds and PDF/e-signature are not.** See [docs/BUILD_PLAN.md](docs/BUILD_PLAN.md). Not yet production-ready: see "Before going live" below.

Proposed stack (same as the Tendwell project): Next.js, TypeScript, Supabase
(Postgres, Auth, row-level security), Tailwind, Vitest.

## Phase 1 (built): foundation
Auth, workspaces and switching, members, invitations, roles and permissions,
audit trail, tenant isolation. Next.js pages under `app/(app)/w/[slug]`; all
writes are RPCs in `supabase/migrations/20261105000200_*`, clients can only
SELECT through RLS (`...000300_*`).

```bash
npm install
npm test                 # unit tests (no database needed)
npm run test:db:local    # database tests on a throw-away plain Postgres (no Docker)
npm run db:start         # or: local Supabase, then `npm run test:db`
cp .env.example .env.local && npm run dev
```

Rules worth knowing:
- Only RPCs change data; every RPC re-checks membership and permission.
- You can only grant, edit or act on power you hold yourself (no escalation).
- A workspace always keeps one active owner.
- Invitation tokens are stored hashed; with no email service yet, the inviter sees the link once.
- Not yet verified against a live Supabase stack (no Docker here): the Next.js pages are type-checked and built, the SQL is tested on Postgres 16 with a stand-in `auth` schema.

## Phases 2-3 (built): core CRM
Accounts, contacts, duplicate protection, lead inbox with explainable scoring,
web capture form at `/capture/<workspace>`, round-robin assignment, lead
conversion (links existing records), pipeline board with automatic history,
Today queue, activity timeline. Visibility is ownership-based: Staff see their
own records, Managers/Owners (`crm.read_all`) see the workspace. Nothing is
deleted; records are archived. Tests: `tests/db/crm.test.ts`.

## Before going live
Not built yet, and required for a sellable SaaS: public marketing site, plans and
subscription billing, transactional email (invitations, password reset), email
sync and outreach sequences, meetings, quotes, forecasting, platform super-admin,
CSV import/export, rate limiting on the public form, backups and monitoring.
Deploy target: any Node 22 host (e.g. Vercel) plus a hosted Supabase project;
apply `supabase/migrations/` with `supabase db push`, set the two
`NEXT_PUBLIC_SUPABASE_*` variables, and turn on email confirmation in Supabase Auth.

## SaaS layer (built, needs your keys to go live)
- Marketing site: `/`, `/features`, `/pricing` (reads the `plans` table), `/demo`.
- 14-day trial on Growth for every new workspace; seat limits per plan (open invitations hold a seat); `/w/<slug>/billing`.
- Razorpay: checkout creates a subscription; webhook `POST /api/razorpay/webhook` verifies the signature and updates status idempotently. Create the 3 plans x 2 intervals in Razorpay and put their ids in `plans.razorpay_plan_monthly/yearly`.
- Brevo: invitations are emailed when `BREVO_API_KEY` and `EMAIL_FROM_ADDRESS` are set (sender must be verified in Brevo); otherwise the link is shown.
- `/admin`: platform staff only. Make the first one in SQL:
  `insert into platform_staff (user_id, role) select id, 'owner' from profiles where email = 'you@example.com';`
- Expiry: run "Suspend lapsed trials and unpaid workspaces" in `/admin` (schedule it daily once you have a job runner).
- Plan prices are placeholders (Starter 1,499 / Growth 4,999 / Scale 12,999 per month); edit the `plans` table.
- Unverified against live Razorpay/Brevo/Supabase: signature check, event parsing and all SQL are tested; the HTTP calls to Razorpay and Brevo are not.

## Quotes and forecast (built)
- Catalogue (`/products`), quotes with per-line GST, discount approval above a workspace threshold (default 10%), no self-approval except owners, locked once submitted, versions via "Create revision" (revising an accepted quote needs a quote approver).
- Customer review at `/quote/<token>`: no account needed; accepting moves the opportunity to Won at the quoted total. The link is shown once to the sender (emailing it comes with the mailbox work). Expiry is checked when the customer responds and shown live; "expire_quotes" updates stored statuses.
- Money rule is identical in SQL and `lib/rules/quote.ts`; a test compares them.
- Forecast: Commit/Best case/Pipeline from stage probability, manager adjustments (reason required, history kept) shown beside the calculation, team/owner targets, immutable snapshots with change since the last one, slipping deals.
- Formal e-signatures and PDF generation are not included (separate services per the scope).

## Teams, handover, renewals, import/export (built)
- Teams: a team lead sees and can work on records owned by their team members. Reassignment (`Teams` page) moves a leaver's live records in one audited step; won/lost deals keep their owner.
- Handover: created automatically when a deal is won, with the accepted quote's terms, a 5-item checklist, scope/commitments, escalation note; completion needs every item. Renewal or expansion opportunities start from a won deal and appear under Renewals.
- CSV import (accounts, contacts, leads): validated twice (in the browser flow and again in the database), per-row errors, duplicates skipped, safe to re-run. Export (accounts, contacts, leads, opportunities) respects row visibility, needs the `crm.export` permission (owners by default), neutralises spreadsheet formulas, and is audited.
- Not built: automatic territory rules (matching by attribute) and shared-account access beyond teams; see "Not built" notes in the final summary.

## Reports, API and webhooks (built)
- Reports (`/reports`): lead sources, funnel, sales cycle, stage ageing, seller performance (outcomes first), lost deals. Date range, saved/shared views, CSV download (needs `crm.export`, audited). They run as the viewer, so staff see their own numbers and managers the workspace's.
- Public API: `GET /api/v1/{accounts|contacts|leads|opportunities}?limit&after` and `POST /api/v1/leads` with `Authorization: Bearer sk_live_...`. Keys are scoped, stored hashed, shown once, revocable, limited to 120 requests/minute, and work only while the workspace is not suspended.
- Webhooks: `lead.created`, `opportunity.won`, `quote.accepted` to https endpoints only, signed with HMAC-SHA256 (`X-Webhook-Signature`, `X-Webhook-Timestamp`). Retries after 1m, 5m, 30m, 2h, 12h, then marked dead (owner can retry). Targets that resolve to private addresses are refused at send time.
- **Scheduler needed**: something must call `POST /api/webhooks/dispatch` every minute with `Authorization: Bearer $CRON_SECRET` (e.g. a Vercel cron, GitHub Actions schedule, or any cron service). Without it, deliveries queue but are not sent. Same for `POST /api/razorpay/webhook`'s sibling needs: none.
- Scheduled report emails are not built (needs the email work and a scheduler).

## Leftovers pass (built)
- Duplicates (`/duplicates`): likely pairs for accounts and contacts, field-by-field preview with conflicts, merge keeps the survivor's values and fills only empty fields, moves deals/contacts/activities/handovers, archives the other, logs the removed record.
- Pipeline settings: add, rename, reorder, delete stages (not while deals are in them), win probability, up to 5 pipelines created from templates (Services, Distribution, Blank); the pipeline page switches between pipelines.
- Custom fields: up to 20 per record type (text, number, date, choice, yes/no, required option); validated in the database for accounts, contacts, leads and opportunities; the editing screen exists on the account page only. Hiding a field keeps its data.
- Two-step sign-in (TOTP authenticator): `/security` to enrol, `/mfa` to verify; middleware requires it once enrolled. **Untested end to end** (needs Supabase Auth).
- Support access: owners grant 4h/24h/3d windows with a reason; platform support then sees counts and recent audit only (never records) and each view is audited.
- Workspace closure: owner types the workspace address, 30-day countdown with full use and export, cancel any time; platform owners purge workspaces past 30 days (the audit entry is kept).
- `node scripts/a11y-smoke.mjs` runs axe (WCAG 2.1 AA) and a horizontal-scroll check at desktop and phone width on the public pages; it also runs in CI. Signed-in screens still need a live Supabase to be checked the same way.

## Final build pass (built)
- **Lead territories** (Teams page): domain rules, first match wins, never takes a lead from its owner; web/API capture consults them before round robin. Documented defaults, change if your process differs.
- **Scheduled report emails** (Reports page): weekly (Mon 07:00 IST) or monthly (1st), members only, needs `crm.read_all` + `crm.export`. Scheduler: `POST /api/reports/dispatch` hourly with `Authorization: Bearer $CRON_SECRET`.
- **Outreach sequences** (Sequences): email and call-task steps, manager approval to go live, steps frozen after activation, daily cap and sending window, suppression and opt-out re-checked before every send, stops on reply / unsubscribe / opt-out / owner leaving / 3 failed sends, reassigning moves live sequences. Every email gets an unsubscribe link and RFC 8058 one-click headers. Sent through Brevo from your verified sender with the seller as Reply-To. Scheduler: `POST /api/sequences/dispatch` every 5 minutes. **Replies are marked by hand** ("They replied") because there is no mailbox sync. No open/click tracking by design.
- **Meetings and booking pages**: availability per person, public booking page `/book/<address>`, server-side slot check, buffers, notice and window, a database constraint that makes double-booking impossible, attendee self-cancel link `/m/<token>`, outcomes (attended / no-show), calendar download (.ics).
- **Contact page** with custom fields, sequences, meetings and timeline; custom fields now also appear in lead and pipeline cards.
- Accessibility smoke test now also covers pricing, booking, booking-management, quote review and unsubscribe pages (12 pages at desktop and phone width, all pass).

### Not built, and why
- Google/Microsoft mailbox and calendar **sync**: needs OAuth app credentials from you. Until then replies are marked by hand and meetings live in this app (with .ics export).
- **Coupons and refunds**: they happen inside Razorpay; money movement should stay a deliberate dashboard action until you decide the rules.
- **PDF quotes and e-signatures**: separate paid services in your scope document.
- Load testing and signed-in browser testing: need a live Supabase project.
