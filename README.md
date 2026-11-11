# Sales CRM and Outreach SaaS

Multi-tenant CRM for B2B teams, distributors, agencies and service businesses:
accounts, contacts, lead intake, opportunities, outreach sequences, meetings,
quotations, forecasting and sales handover. Each subscribing company is isolated.

**Status: foundation, core CRM, leads/pipeline, marketing site, plans and trials, Razorpay billing, Brevo email and platform admin are built; quotes (catalogue, GST, approvals, customer review link, revisions) and forecasting (targets, adjustments, snapshots) are built; Google mail/calendar sync, sequences, meetings, import/export are not.** See [docs/BUILD_PLAN.md](docs/BUILD_PLAN.md). Not yet production-ready: see "Before going live" below.

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
