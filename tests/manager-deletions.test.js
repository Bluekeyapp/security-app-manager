import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const siteId = "00000000-0000-0000-0000-000000000002";
const migration = await readFile(new URL("../supabase/manager-deletions.sql", import.meta.url), "utf8");
const historyMigration = await readFile(new URL("../supabase/clear-activity-history.sql", import.meta.url), "utf8");

test("manager deletion rules preserve history and enforce permissions", async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  const schema = await readFile(new URL("../supabase/schema.sql", import.meta.url), "utf8");
  const operations = await readFile(new URL("../supabase/operations-upgrade.sql", import.meta.url), "utf8");
  await db.exec(schema.split("insert into public.sites")[0]);
  await db.exec(operations.split("create index if not exists idx_incidents_created_at")[0]);
  await db.exec(`
    create role anon;
    create role authenticated;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('test.user_id', true), '')::uuid $$;
    create table public.manager_users (user_id uuid primary key);
    insert into public.manager_users (user_id) values ('00000000-0000-0000-0000-000000000010');
    set test.user_id = '00000000-0000-0000-0000-000000000010';
    create function public.is_current_user_manager() returns boolean language sql as
      $$ select coalesce(current_setting('test.is_manager', true), '') = 'yes' $$;
    set test.is_manager = 'yes';
  `);
  await db.exec(migration);
  await db.exec(migration);
  const qrMigration = await readFile(new URL("../supabase/qr-management.sql", import.meta.url), "utf8");
  await db.exec(qrMigration);
  await db.exec(qrMigration);
  await db.exec(`
    create function public.authenticate_agent(p_badge text, p_pin text)
      returns table (id text, name text, badge text, site_id uuid, site_name text, all_sites_access boolean)
      language sql as $$
        select 'agent-test', 'Test Agent', 'TEST', '${siteId}'::uuid, 'Test Site', true
        where p_badge = 'TEST' and p_pin = '123456'
      $$;
    create function public.get_agent_route(text, text) returns jsonb language sql as $$ select '[]'::jsonb $$;
    create function public.get_agent_routes(text, text) returns jsonb language sql as $$ select '[]'::jsonb $$;
    create function public.sync_agent_tour(text, text, jsonb) returns jsonb language sql as $$ select '{"ok":true}'::jsonb $$;
    create function public.sync_agent_tour_for_site(text, text, jsonb) returns jsonb language sql as $$ select '{"ok":true}'::jsonb $$;
  `);
  await db.exec(historyMigration);
  await db.exec(historyMigration);

  t.beforeEach(async () => {
    await db.exec(`
      reset role;
      set test.is_manager = 'yes';
      truncate public.incidents, public.tour_scans, public.tours, public.checkpoints, public.agents, public.sites cascade;
      insert into public.sites (id, name) values ('${siteId}', 'Test Site');
      insert into public.agents (id, name, badge, site_id) values ('agent-test', 'Test Agent', 'TEST', '${siteId}');
      insert into public.checkpoints (id, site_id, label, kind, qr_payload) values
        ('start-test', '${siteId}', 'Poste A', 'start', 'START'),
        ('point-test', '${siteId}', 'Point test', 'checkpoint', 'POINT');
      insert into public.tours (id, site_id, agent_id, agent_name, agent_badge, status, started_at)
        values ('tour-test', '${siteId}', 'agent-test', 'Test Agent', 'TEST', 'completed', now());
      insert into public.tour_scans (id, tour_id, agent_id, checkpoint_id, point_label, scan_type, scanned_at)
        values ('scan-test', 'tour-test', 'agent-test', 'point-test', 'Point test', 'checkpoint', now());
      insert into public.incidents (id, tour_id, site_id, agent_id, category)
        values ('incident-test', 'tour-test', '${siteId}', 'agent-test', 'Incident');
    `);
  });

  await t.test("anonymous users and non-manager accounts cannot delete", async () => {
    await db.exec("set role anon");
    await assert.rejects(db.query("select manager_delete_agent('agent-test')"), /permission denied/);
    await db.exec("set role authenticated; set test.is_manager = 'no'");
    for (const query of ["select manager_delete_agent('agent-test')", `select manager_delete_site('${siteId}')`, "select manager_delete_checkpoint('point-test')"]) {
      await assert.rejects(db.query(query), /Manager access required/);
    }
  });

  await t.test("agent removal retains tours, scan labels and incidents", async () => {
    await db.exec("set role authenticated");
    assert.equal((await db.query("select manager_delete_agent('agent-test') as deleted")).rows[0].deleted, true);
    await db.exec("reset role");
    assert.equal((await db.query("select * from agents")).rows.length, 0);
    const tour = (await db.query("select * from tours")).rows[0];
    assert.equal(tour.agent_id, null);
    assert.equal(tour.agent_name, "Test Agent");
    assert.equal((await db.query("select * from tour_scans")).rows[0].point_label, "Point test");
    assert.equal((await db.query("select * from incidents")).rows.length, 1);
  });

  await t.test("all deletion types are blocked during an active patrol", async () => {
    await db.exec("update tours set status = 'active'");
    for (const query of ["select manager_delete_agent('agent-test')", `select manager_delete_site('${siteId}')`, "select manager_delete_checkpoint('point-test')"]) {
      await assert.rejects(db.query(query), /Active patrol/);
    }
    assert.equal((await db.query("select * from agents")).rows.length, 1);
    assert.equal((await db.query("select * from checkpoints")).rows.length, 2);
  });

  await t.test("a QR can be deleted while its recorded scan remains", async () => {
    await db.query("select manager_delete_checkpoint('point-test')");
    const scan = (await db.query("select * from tour_scans")).rows[0];
    assert.equal(scan.checkpoint_id, null);
    assert.equal(scan.point_label, "Point test");
    assert.equal((await db.query("select * from checkpoints")).rows.length, 1);
  });

  await t.test("departure QR can be replaced with a new unique code", async () => {
    await db.exec("set role anon");
    await assert.rejects(db.query(`select manager_create_starting_post('${siteId}')`), /permission denied/);
    await db.exec("reset role");
    await assert.rejects(db.query(`select manager_create_starting_post('${siteId}')`), /already exists/);
    await db.exec("update tours set status = 'active'");
    await assert.rejects(db.query("select manager_delete_checkpoint('start-test')"), /Active patrol/);
    await db.exec("update tours set status = 'completed'");
    await db.exec("insert into tour_scans (id,tour_id,agent_id,checkpoint_id,point_label,scan_type,scanned_at) values ('start-scan','tour-test','agent-test','start-test','Poste A','start',now())");
    assert.equal((await db.query("select manager_delete_checkpoint('start-test') as deleted")).rows[0].deleted, true);
    assert.equal((await db.query("select point_label from tour_scans where id = 'start-scan'")).rows[0].point_label, 'Poste A');
    assert.equal((await db.query(`select manager_create_starting_post('${siteId}') as created`)).rows[0].created, true);
    const replacement = (await db.query("select * from checkpoints where kind = 'start'")).rows[0];
    assert.notEqual(replacement.id, 'start-test');
    assert.notEqual(replacement.qr_payload, 'START');
  });

  await t.test("an assigned site can be removed", async () => {
    assert.equal((await db.query(`select manager_delete_site('${siteId}') as deleted`)).rows[0].deleted, true);
    const agent = (await db.query("select site_id, active from agents where id = 'agent-test'")).rows[0];
    assert.equal(agent.site_id, null);
    assert.equal(agent.active, false);
  });

  await t.test("site removal deletes its QR codes but retains history and site name", async () => {
    await db.query(`select manager_delete_site('${siteId}')`);
    assert.equal((await db.query("select * from sites")).rows.length, 0);
    assert.equal((await db.query("select * from checkpoints")).rows.length, 0);
    const tour = (await db.query("select * from tours")).rows[0];
    assert.equal(tour.site_id, null);
    assert.equal(tour.site_name, "Test Site");
    assert.equal((await db.query("select * from tour_scans")).rows.length, 1);
    assert.equal((await db.query("select * from incidents")).rows.length, 1);
    const agent = (await db.query("select site_id, active from agents where id = 'agent-test'")).rows[0];
    assert.equal(agent.site_id, null);
    assert.equal(agent.active, false);
  });

  await t.test("missing records do not report a successful deletion", async () => {
    for (const query of ["select manager_delete_agent('missing') as deleted", "select manager_delete_checkpoint('missing') as deleted", "select manager_delete_site('00000000-0000-0000-0000-000000000099') as deleted"]) {
      assert.equal((await db.query(query)).rows[0].deleted, false);
    }
  });

  await t.test("manager can clear tours with their scans and incidents", async () => {
    await db.exec("set role authenticated");
    const result = (await db.query("select manager_purge_activity_history_v2() as result")).rows[0].result;
    assert.equal(Number(result.deleted_count), 1);
    assert.equal(result.ok, true);
    await db.exec("reset role");
    assert.equal((await db.query("select * from tours")).rows.length, 0);
    assert.equal((await db.query("select * from tour_scans")).rows.length, 0);
    assert.equal((await db.query("select * from incidents")).rows.length, 0);
  });

  await t.test("history deletion is manager-only and closes active patrols", async () => {
    await db.exec("set role anon");
    await assert.rejects(db.query("select manager_purge_activity_history_v2()"), /permission denied/);
    await db.exec("reset role; update tours set status = 'active'; set role authenticated");
    const result = (await db.query("select manager_purge_activity_history_v2() as result")).rows[0].result;
    assert.equal(Number(result.deleted_count), 1);
    await db.exec("reset role");
    assert.equal((await db.query("select * from tours")).rows.length, 0);
  });

  await t.test("history deletion rotates the agent session epoch", async () => {
    const before = (await db.query("select agent_session_epoch from app_control")).rows[0].agent_session_epoch;
    assert.equal((await db.query(`select check_agent_session('TEST', '123456', '${before}') as valid`)).rows[0].valid, true);
    await db.query("select manager_purge_activity_history_v2()");
    const after = (await db.query("select agent_session_epoch from app_control")).rows[0].agent_session_epoch;
    assert.notEqual(after, before);
    assert.equal((await db.query(`select check_agent_session('TEST', '123456', '${before}') as valid`)).rows[0].valid, false);
    const renewed = (await db.query("select session_epoch from authenticate_agent_session('TEST', '123456')")).rows[0].session_epoch;
    assert.equal(renewed, after);
  });
});
