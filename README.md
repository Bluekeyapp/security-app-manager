# SAB Security Manager

The administration dashboard used by authorized SAB Security managers.

## What this repository contains

- Supabase manager sign-in and manager authorization checks.
- Agent, site, checkpoint, QR-code, and activity-journal administration.
- Live operation updates and client PDF reports.
- Manager-only client code, remote data calls, database migrations, and manager tests.

The mobile Agent application is maintained in the separate `security-app-agent` repository.

## Run locally

```powershell
npm ci
npm start
```

Open `http://localhost:8080/`; the root page redirects to `manager.html`.

## Test

```powershell
npm test
```

## Supabase setup

The manager login offers **Rester connecté**. When selected, Supabase's session
tokens are saved on this device and refreshed by the SDK. Otherwise they stay in
the current browser session. The password is never saved by the app. Signing out
clears the remembered session. Existing logins saved before this option may need
to sign in once again to choose whether to stay connected.

The `supabase/` directory contains the schema and migrations used by the dashboard. For a new database, apply them in this order. Do not replay `schema.sql` against an existing production database; inspect its migration state first.

1. `schema.sql`
2. `security-migration.sql`
3. `operations-upgrade.sql`
4. `manager-deletions.sql`
5. `multi-site-access.sql`
6. `all-agents-all-sites.sql`
7. `clear-activity-history.sql`
8. `qr-management.sql`
9. `api-grants.sql`
10. `remembered-agent-sessions.sql`
11. `agent-pin-null-hardening.sql`
12. `tour-write-ownership-hardening.sql`
13. `agent-pin-attempts-hardening.sql`

Apply `agent-pin-null-hardening.sql` after migrations 1–10. It replaces four functions to
reject missing or malformed PINs and make hash comparisons NULL-safe, without
changing existing agent PINs or session records. Older migrations redefine these
functions: if any are replayed, reapply this hardening migration afterward.
Applying it to production is a separate database deployment; publishing the
static apps alone does not install the fix.

Apply `tour-write-ownership-hardening.sql` afterward. It checks ownership in
the conflict update itself for tours, scans and incidents, on both Badge/PIN
session and remembered-token synchronization paths. A conflicting identifier
from another tour or agent rejects and rolls back the entire request. The Agent
keeps a rejected upload pending rather than silently discarding it. Legitimate
retries and updates of the same owned tour remain supported. Existing rows,
RLS, PIN validation and session records are preserved; no frontend deployment
is required. Reapply this migration if older synchronizer migrations are replayed.

Apply `agent-pin-attempts-hardening.sql` last. It locks the agent row before
checking the PIN and the existing five-attempt / fifteen-minute lockout. Failed
route or tour session requests return a JSON error with PostgREST HTTP status 401
and code `28000`, instead of raising an exception that rolls back the counter.
Login and session checks keep their existing empty/null/false rejection formats.
No Agent frontend update is needed: Supabase's SDK already handles HTTP errors.
Tour validation and ownership errors still roll back all tour writes. PINs,
existing sessions, patrols and RLS are preserved. Older authentication or session
migrations must be followed by reapplying this migration.

This counter depends on normal PostgREST request transactions being committed.
Before production acceptance, verify that `db-tx-end` is `commit` and that clients
cannot request transaction rollback (no `commit-allow-override` setting). Never
enable rollback overrides for these public authentication RPCs. SQL tests use
PGlite, not the production PostgREST gateway; verify real HTTP 401 responses and
counter persistence on an isolated Supabase test agent before accepting the fix.

The final migration grants authenticated managers read access to the tables used by the dashboard and revokes anonymous access to manager RPCs. Manager-only row policies still restrict the rows. This works with Supabase's "Automatically expose new tables" setting turned off.

Create the manager account in Supabase Authentication, then grant access with the account's user ID:

```sql
insert into public.manager_users (user_id)
values ('YOUR_AUTH_USER_UUID')
on conflict (user_id) do nothing;
```

The browser uses the publishable Supabase key in `src/config.js`. Manager authorization is enforced by Supabase policies and RPC functions; the dashboard does not replace those server-side checks.

## Deployment

This repository is a static site. Cloudflare Pages publishes the `main` branch at https://security-app-manager.pages.dev/. GitHub Actions runs tests on pushes and pull requests. No build command is required. The manager entry point is `manager.html`; publish it with `index.html` and the `assets/`, `src/`, `styles/`, and `vendor/` directories.

## Remembered agent sessions

After `supabase/clear-activity-history.sql`, apply `supabase/remembered-agent-sessions.sql` before deploying the agent client's « Rester connecté » option. It creates 30-day opaque bearer tokens. Only SHA-256 token hashes are stored server-side; the PIN is never persisted in the agent browser. Sessions are invalidated by sign out, agent deactivation, PIN reset, expiry, or the global activity reset.
