import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

test("final grants close inherited anonymous access without blocking managers", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon;
      create role authenticated;
      create table agents (id text);
      create table sites (id text);
      create table checkpoints (id text);
      create table tours (id text);
      create table tour_scans (id text);
      create table incidents (id text);
      create table manager_users (id text);
      create function public.manager_create_agent(text) returns boolean
        language sql as $$ select true $$;
      create function public.is_current_user_manager() returns boolean
        language sql as $$ select true $$;
      grant select on all tables in schema public to anon, authenticated;
      grant execute on function public.manager_create_agent(text) to anon, authenticated;
      grant execute on function public.is_current_user_manager() to anon, authenticated;
    `);

    const migration = await readFile(new URL("../supabase/api-grants.sql", import.meta.url), "utf8");
    await db.exec(migration);
    await db.exec(migration);

    const result = await db.query(`
      select
        has_table_privilege('anon', 'public.sites', 'SELECT') as anon_sites,
        has_table_privilege('authenticated', 'public.sites', 'SELECT') as manager_sites,
        has_table_privilege('authenticated', 'public.manager_users', 'SELECT') as manager_membership,
        has_function_privilege('anon', 'public.manager_create_agent(text)', 'EXECUTE') as anon_manager_rpc,
        has_function_privilege('authenticated', 'public.manager_create_agent(text)', 'EXECUTE') as manager_rpc,
        has_function_privilege('anon', 'public.is_current_user_manager()', 'EXECUTE') as anon_manager_check
    `);
    assert.deepEqual(result.rows[0], {
      anon_sites: false,
      manager_sites: true,
      manager_membership: false,
      anon_manager_rpc: false,
      manager_rpc: true,
      anon_manager_check: false
    });
  } finally {
    await db.close();
  }
});
