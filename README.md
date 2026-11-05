# Sales CRM and Outreach SaaS

Multi-tenant CRM for B2B teams, distributors, agencies and service businesses:
accounts, contacts, lead intake, opportunities, outreach sequences, meetings,
quotations, forecasting and sales handover. Each subscribing company is isolated.

**Status: Phases 1–3 built (foundation, core CRM, leads and pipeline); Phases 4–9 not built.** See [docs/BUILD_PLAN.md](docs/BUILD_PLAN.md). Not yet production-ready: see "Before going live" below.

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
