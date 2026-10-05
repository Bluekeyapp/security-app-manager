import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createLocalDatabase } from "./helpers/local-database.js";

const sql = (name) => readFile(new URL(`../supabase/${name}`, import.meta.url), "utf8");
const managerId = "00000000-0000-0000-0000-000000000010";

test("PIN hardening closes the historical bypass without changing valid sessions", async (t) => {
  const db = await createLocalDatabase(t, { hardenPin: false });
  await db.exec(`insert into public.manager_users values ('${managerId}', now());
    set test.user_id = '${managerId}'; set role authenticated;`);
  const createAgent = async (badge, pin) => (await db.query(
    "select id from public.manager_create_agent('Test Agent', $1, $2, null, true)", [badge, pin]
  )).rows[0]?.id;
  const agentId = await createAgent("A1", "123456");
  await db.exec("set test.user_id = ''; set role anon");
  const login = async (pin) => (await db.query(
    "select * from public.authenticate_agent_session('A1', $1)", [pin]
  )).rows;
  const remember = async (pin) => (await db.query(
    "select public.create_remembered_agent_session('A1', $1) as session", [pin]
  )).rows[0].session;
  const validToken = (await remember("123456")).token;
  const epoch = (await login("123456"))[0].session_epoch;

  await t.test("the pre-migration SQL reproduces the NULL PIN vulnerability", async () => {
    assert.equal((await login(null))[0].id, agentId);
    assert.match((await remember(null)).token, /^[0-9a-f]{64}$/);
  });
  await db.exec("reset role");
  const before = (await db.query("select id, pin_hash from public.agents order by id")).rows;
  const migration = await sql("agent-pin-null-hardening.sql");
  await db.exec(migration);
  await db.exec(migration);
  assert.deepEqual((await db.query("select id, pin_hash from public.agents order by id")).rows, before);
  await db.exec("set role anon");

  await t.test("missing and malformed PINs cannot authenticate or mint tokens", async () => {
    for (const pin of [null, "", "12345", "1234567", "abcdef", " 123456", "123456 ", "123456\n"]) {
      assert.deepEqual(await login(pin), [], `login rejected ${JSON.stringify(pin)}`);
      assert.equal(await remember(pin), null, `token rejected ${JSON.stringify(pin)}`);
    }
    assert.deepEqual(await login("000000"), []);
    assert.equal(await remember("000000"), null);
    assert.equal((await login("123456"))[0].id, agentId);
  });

  await t.test("session wrappers reject NULL PINs before reading routes or writing tours", async () => {
    assert.equal((await db.query(
      "select public.check_agent_session('A1', null, $1) as valid", [epoch]
    )).rows[0].valid, false);
    for (const pin of [null, "", "bad", "000000"]) {
      await assert.rejects(db.query(
        "select public.get_agent_routes_session('A1', $1, $2)", [pin, epoch]
      ), /Agent session expired/);
      await assert.rejects(db.query(
        "select public.sync_agent_tour_session('A1', $1, $2, '{}'::jsonb)", [pin, epoch]
      ), /Agent session expired/);
    }
    const routes = (await db.query(
      "select public.get_agent_routes_session('A1', '123456', $1) as routes", [epoch]
    )).rows[0].routes;
    assert.equal(routes.length, 1);
  });

  await t.test("valid new and preexisting remembered sessions remain usable", async () => {
    const tour = (id) => ({
      id, siteId: "00000000-0000-0000-0000-000000000001", status: "active",
      startedAt: "2026-10-05T12:00:00Z",
      scans: [{ id: `${id}-start`, pointId: "post-a", type: "start", scannedAt: "2026-10-05T12:00:00Z" }],
      incidents: []
    });
    let index = 0;
    for (const token of [validToken, (await remember("123456")).token]) {
      assert.equal((await db.query(
        "select public.resume_remembered_agent_session($1) as agent", [token]
      )).rows[0].agent.id, agentId);
      assert.equal((await db.query(
        "select public.get_agent_routes_token($1) as routes", [token]
      )).rows[0].routes.length, 1);
      const payload = tour(`token-tour-${++index}`);
      assert.deepEqual((await db.query(
        "select public.sync_agent_tour_token($1, $2::jsonb) as result", [token, JSON.stringify(payload)]
      )).rows[0].result, { ok: true, tour_id: payload.id });
    }
    const payload = tour("pin-tour");
    assert.deepEqual((await db.query(
      "select public.sync_agent_tour_session('A1', '123456', $1, $2::jsonb) as result",
      [epoch, JSON.stringify(payload)]
    )).rows[0].result, { ok: true, tour_id: payload.id });
    await assert.rejects(db.query("select public.authenticate_agent('A1', null)"), /permission denied/);
    await assert.rejects(db.query("select public.manager_reset_agent_pin($1, null)", [agentId]), /permission denied/);
  });

  await t.test("manager creation and reset reject invalid PINs without changing records", async () => {
    await db.exec(`set test.user_id = '${managerId}'; set role authenticated`);
    for (const pin of [null, "", "12345", "1234567", "abcdef", "123456\n"]) {
      await assert.rejects(createAgent("BAD", pin), /PIN must contain exactly 6 digits/);
      await assert.rejects(db.query("select public.manager_reset_agent_pin($1, $2)", [agentId, pin]),
        /PIN must contain exactly 6 digits/);
    }
    await db.exec("reset role");
    assert.deepEqual((await db.query("select id, pin_hash from public.agents order by id")).rows, before);
    await db.exec(`set role authenticated; set test.user_id = '${managerId}'`);
    assert.ok(await createAgent("A2", "654321"));
    assert.equal((await db.query("select public.manager_reset_agent_pin($1, '654321') as ok", [agentId])).rows[0].ok, true);
    await db.exec("set test.user_id = ''; set role anon");
    assert.equal(await remember("123456"), null);
    assert.equal((await db.query("select public.resume_remembered_agent_session($1) as agent", [validToken])).rows[0].agent, null);
    assert.equal((await login("654321"))[0].id, agentId);
  });

  await t.test("non-managers, disabled agents, locks and expired epochs remain denied", async () => {
    await db.exec("set role authenticated; set test.user_id = ''");
    await assert.rejects(createAgent("A3", "123456"), /Manager access required/);
    await assert.rejects(db.query("select public.manager_reset_agent_pin($1, '123456')", [agentId]), /Manager access required/);
    await db.exec("reset role");
    await db.query("update public.agents set active = false where id = $1", [agentId]);
    await db.exec("set role anon");
    assert.deepEqual(await login("654321"), []);
    assert.equal(await remember("654321"), null);
    await db.exec("reset role");
    await db.query("update public.agents set active = true, locked_until = now() + interval '15 minutes' where id = $1", [agentId]);
    await db.exec("set role anon");
    assert.deepEqual(await login("654321"), []);
    await db.exec("reset role");
    await db.query("update public.agents set locked_until = null where id = $1", [agentId]);
    await db.exec("update public.app_control set agent_session_epoch = gen_random_uuid(); set role anon");
    assert.equal((await db.query("select public.check_agent_session('A1', '654321', $1) as valid", [epoch])).rows[0].valid, false);
  });
});
