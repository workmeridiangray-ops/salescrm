# Sales CRM and Outreach SaaS

Multi-tenant CRM for B2B teams, distributors, agencies and service businesses:
accounts, contacts, lead intake, opportunities, outreach sequences, meetings,
quotations, forecasting and sales handover. Each subscribing company is isolated.

**Status: planning.** See [docs/BUILD_PLAN.md](docs/BUILD_PLAN.md).

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
