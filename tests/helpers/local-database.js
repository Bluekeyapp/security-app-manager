import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
const sql = (name) => readFile(new URL(`../../supabase/${name}`, import.meta.url), 'utf8');
const managerId = '00000000-0000-0000-0000-000000000010';

export async function createLocalDatabase(t, {hardenPin = true, hardenOwnership = false} = {}) {
  const db = new PGlite();
  t.after(() => db.close());
  // PGlite does not provide pgcrypto here. These STRICT stand-ins reproduce
  // its NULL semantics, not bcrypt security; all application functions are real SQL.
  await db.exec(`
    create role anon;
    create role authenticated;
    create schema auth;
    create table auth.users (id uuid primary key);
    insert into auth.users values ('${managerId}');
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('test.user_id', true), '')::uuid
    $$;
    create schema extensions;
    create function extensions.gen_salt(text, integer) returns text
      language sql immutable strict as $$ select 'test-salt'::text $$;
    create function extensions.crypt(value text, salt text) returns text
      language sql immutable strict as $$
        select 'test-hash:' || encode(sha256(convert_to(value, 'UTF8')), 'hex')
      $$;
    create function extensions.digest(value text, algorithm text) returns bytea
      language sql immutable strict as $$ select sha256(convert_to(value, 'UTF8')) $$;
    create function extensions.gen_random_bytes(length integer) returns bytea
      language sql volatile strict as $$
        select decode(replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''), 'hex')
      $$;
  `);
  await db.exec(await sql("schema.sql"));
  await db.exec((await sql("security-migration.sql")).replace(
    "create extension if not exists pgcrypto with schema extensions;", ""
  ));
  // Publication management is external to PIN validation and absent in PGlite.
  await db.exec((await sql("operations-upgrade.sql")).split("do $$")[0]);
  for (const name of ["manager-deletions.sql", "multi-site-access.sql", "all-agents-all-sites.sql",
    "clear-activity-history.sql", "qr-management.sql", "api-grants.sql", "remembered-agent-sessions.sql"]) {
    await db.exec(await sql(name));
  }
  if (hardenPin) await db.exec(await sql('agent-pin-null-hardening.sql'));
  if (hardenOwnership) await db.exec(await sql('tour-write-ownership-hardening.sql'));
  return db;
}
