import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

test("remembered agent tokens expire, revoke, and respect account resets", async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    create role anon;
    create role authenticated;
    create schema extensions;
    create function extensions.digest(value text, algorithm text) returns bytea
      language sql immutable as $$ select sha256(convert_to(value, 'UTF8')) $$;
    create function extensions.gen_random_bytes(length integer) returns bytea
      language sql volatile as $$ select decode(repeat(replace(gen_random_uuid()::text, '-', ''), 2), 'hex') $$;
    create function extensions.crypt(value text, salt text) returns text
      language sql immutable as $$ select value $$;
    create table public.sites (id uuid primary key, name text, address text, active boolean default true);
    create table public.agents (
      id text primary key, name text, badge text, site_id uuid, all_sites_access boolean,
      active boolean default true, pin_hash text
    );
    create table public.checkpoints (
      id text, site_id uuid, label text, kind text, qr_payload text,
      sort_order integer, active boolean default true
    );
    create table public.tours (
      id text primary key, site_id uuid, agent_id text, agent_name text, agent_badge text,
      status text, started_at timestamptz, completed_at timestamptz, cancelled_at timestamptz,
      cancel_reason text, comment text, required_checkpoint_ids text[], updated_at timestamptz
    );
    create table public.tour_scans (
      id text primary key, tour_id text, agent_id text, checkpoint_id text, point_label text,
      scan_type text, scanned_at timestamptz, source_payload text,
      gps_lat double precision, gps_lng double precision, gps_accuracy double precision
    );
    create table public.incidents (
      id text primary key, tour_id text, site_id uuid, agent_id text, category text,
      note text, photo_data text, gps_lat double precision, gps_lng double precision,
      gps_accuracy double precision, created_at timestamptz
    );
    create table public.app_control (id boolean primary key, agent_session_epoch uuid);
    insert into public.app_control values (true, gen_random_uuid());
    insert into public.sites values ('00000000-0000-0000-0000-000000000001', 'Site', '', true);
    insert into public.agents values ('agent-1', 'Agent', 'A1',
      '00000000-0000-0000-0000-000000000001', true, true, '123456');
    insert into public.checkpoints values ('post-a',
      '00000000-0000-0000-0000-000000000001', 'Poste A', 'start', 'START', 1, true);
    insert into public.checkpoints values ('point-1',
      '00000000-0000-0000-0000-000000000001', 'Point 1', 'checkpoint', 'POINT', 2, true);
    create function public.authenticate_agent(p_badge text, p_pin text)
      returns table (id text, name text, badge text, site_id uuid, site_name text, all_sites_access boolean)
      language sql security definer as $$
        select a.id, a.name, a.badge, a.site_id, s.name, a.all_sites_access
        from public.agents a join public.sites s on s.id = a.site_id
        where a.badge = p_badge and a.pin_hash = p_pin and a.active and s.active
      $$;
  `);
  const migration = await readFile(new URL("../supabase/remembered-agent-sessions.sql", import.meta.url), "utf8");
  await db.exec(migration);
  await db.exec("set role anon");
  const login = (await db.query("select public.create_remembered_agent_session('A1', '123456') as session")).rows[0].session;
  assert.match(login.token, /^[0-9a-f]{64}$/);
  assert.equal((await db.query("select public.create_remembered_agent_session('A1', '000000') as session")).rows[0].session, null);
  await assert.rejects(db.query("select * from public.remembered_agent_sessions"), /permission denied/);
  await assert.rejects(db.query("select public.resolve_remembered_agent($1)", [login.token]), /permission denied/);
  const resume = async () => (await db.query("select public.resume_remembered_agent_session($1) as agent", [login.token])).rows[0].agent;
  assert.equal((await resume()).id, "agent-1");
  const routes = (await db.query("select public.get_agent_routes_token($1) as routes", [login.token])).rows[0].routes;
  assert.equal(routes[0].points[0].kind, "start");
  const scan = (id, pointId, type) => ({ id, pointId, type, scannedAt: "2026-01-01T00:00:00Z" });
  const tour = {
    id: "tour-1", siteId: "00000000-0000-0000-0000-000000000001",
    status: "completed", startedAt: "2026-01-01T00:00:00Z",
    scans: [scan("scan-start", "post-a", "start"), scan("scan-point", "point-1", "checkpoint"), scan("scan-close", "post-a", "close")]
  };
  const saved = (await db.query("select public.sync_agent_tour_token($1, $2::jsonb) as result", [login.token, JSON.stringify(tour)])).rows[0].result;
  assert.deepEqual(saved, { ok: true, tour_id: "tour-1" });
  await db.query("select public.revoke_remembered_agent_session($1)", [login.token]);
  assert.equal(await resume(), null);
  await assert.rejects(db.query("select public.get_agent_routes_token($1)", [login.token]), /Agent session expired/);
  await assert.rejects(db.query("select public.sync_agent_tour_token($1, '{}'::jsonb)", [login.token]), /Agent session expired/);
  await db.exec("reset role");
  const token2 = (await db.query("select public.create_remembered_agent_session('A1', '123456') as session")).rows[0].session.token;
  await db.exec("update public.agents set pin_hash = '654321' where id = 'agent-1'");
  assert.equal((await db.query("select public.resume_remembered_agent_session($1) as agent", [token2])).rows[0].agent, null);
  const token3 = (await db.query("select public.create_remembered_agent_session('A1', '654321') as session")).rows[0].session.token;
  await db.exec("update public.agents set active = false where id = 'agent-1'");
  assert.equal((await db.query("select public.resume_remembered_agent_session($1) as agent", [token3])).rows[0].agent, null);
  await db.exec("update public.agents set active = true where id = 'agent-1'");
  await db.exec("update public.app_control set agent_session_epoch = gen_random_uuid()");
  assert.equal((await db.query("select public.resume_remembered_agent_session($1) as agent", [token3])).rows[0].agent, null);
  const token4 = (await db.query("select public.create_remembered_agent_session('A1', '654321') as session")).rows[0].session.token;
  await db.query("update public.remembered_agent_sessions set expires_at = now() - interval '1 second' where token_hash = extensions.digest($1, 'sha256')", [token4]);
  assert.equal((await db.query("select public.resume_remembered_agent_session($1) as agent", [token4])).rows[0].agent, null);
});
