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

The `supabase/` directory contains the schema and migrations used by the dashboard. Apply them in the existing Supabase project in this order when setting up a new database:

1. `schema.sql`
2. `security-migration.sql`
3. `operations-upgrade.sql`
4. `manager-deletions.sql`
5. `multi-site-access.sql`
6. `all-agents-all-sites.sql`
7. `clear-activity-history.sql`
8. `qr-management.sql`

Create the manager account in Supabase Authentication, then grant access with the account's user ID:

```sql
insert into public.manager_users (user_id)
values ('YOUR_AUTH_USER_UUID')
on conflict (user_id) do nothing;
```

The browser uses the publishable Supabase key in `src/config.js`. Manager authorization is enforced by Supabase policies and RPC functions; the dashboard does not replace those server-side checks.

## Deployment

This repository is a static site. The GitHub Pages workflow runs tests before publishing only the runtime files. For other static hosts, publish `index.html`, `manager.html`, `.nojekyll`, and the `assets/`, `src/`, `styles/`, and `vendor/` directories together. No build command is required. The manager entry point is `manager.html`.
