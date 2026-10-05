import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createLocalDatabase } from "./helpers/local-database.js";

const managerId = "00000000-0000-0000-0000-000000000010";
const siteId = "00000000-0000-0000-0000-000000000001";
const payload = (id) => ({ id, siteId, status: "active", startedAt: "2026-10-05T12:00:00Z",
  scans: [{ id: `${id}-start`, pointId: "post-a", type: "start", scannedAt: "2026-10-05T12:00:00Z" }], incidents: [] });

test("failed PIN attempts survive every exposed RPC and enforce lockout", async (t) => {
  const db = await createLocalDatabase(t, { hardenOwnership: true });
  await db.exec(`insert into public.manager_users values ('${managerId}', now());
    set test.user_id = '${managerId}'; set role authenticated;`);
  const agentId = (await db.query("select id from public.manager_create_agent('Agent', 'A1', '123456', null, true)")).rows[0].id;
  await db.query("select * from public.manager_create_agent('Other Agent', 'A2', '123456', null, true)");
  await db.exec("set test.user_id = ''; set role anon");
  const epoch = (await db.query("select * from public.authenticate_agent_session('A1', '123456')")).rows[0].session_epoch;
  const token = (await db.query("select public.create_remembered_agent_session('A1', '123456') as result")).rows[0].result.token;
  const state = async () => {
    await db.exec("reset role");
    const result = (await db.query("select failed_login_attempts, locked_until, pin_hash from public.agents where id = $1", [agentId])).rows[0];
    await db.exec("set role anon");
    return result;
  };
  const resetAttempts = async () => {
    await db.exec("reset role");
    await db.query("update public.agents set failed_login_attempts = 0, locked_until = null, active = true where id = $1", [agentId]);
    await db.exec("set role anon");
  };
  // Model a PostgREST POST transaction, committing even an error HTTP response.
  // Actual HTTP status mapping still requires acceptance testing with PostgREST.
  const request = async (query, parameters) => {
    await db.exec("begin");
    try {
      await db.query("select set_config('response.status', '', true)");
      const result = (await db.query(query, parameters)).rows;
      const status = (await db.query("select current_setting('response.status', true) as status")).rows[0].status;
      await db.exec("commit");
      return { result, status: status || "200" };
    } catch (error) {
      await db.exec("rollback");
      throw error;
    }
  };
  const routes = (pin) => request("select public.get_agent_routes_session('A1', $1, $2) as result", [pin, epoch]);
  const sync = (pin, data = payload("own-tour")) => request(
    "select public.sync_agent_tour_session('A1', $1, $2, $3::jsonb) as result", [pin, epoch, JSON.stringify(data)]);
  const check = (pin) => request("select public.check_agent_session('A1', $1, $2) as result", [pin, epoch]);
  const login = (pin) => request("select * from public.authenticate_agent_session('A1', $1)", [pin]);
  const remember = (pin) => request("select public.create_remembered_agent_session('A1', $1) as result", [pin]);
  const assertHttpRefusal = (response) => {
    assert.equal(response.status, "401");
    assert.deepEqual(response.result[0].result, { code: "28000", message: "Agent session expired" });
  };

  await t.test("old route and synchronization errors rolled back the failed-attempt counter", async () => {
    await assert.rejects(routes("000000"), /Agent session expired/);
    await assert.rejects(sync("000000"), /Agent session expired/);
    assert.equal((await state()).failed_login_attempts, 0);
  });
  const preserved = await state();
  await db.exec("reset role");
  const migration = await readFile(new URL("../supabase/agent-pin-attempts-hardening.sql", import.meta.url), "utf8");
  await db.exec(migration);
  await db.exec(migration);
  await db.exec("set role anon");
  assert.deepEqual(await state(), preserved);

  for (const [name, call, assertDenied] of [
    ["route loading", routes, assertHttpRefusal],
    ["tour synchronization", sync, assertHttpRefusal],
    ["session checks", check, (response) => assert.equal(response.result[0].result, false)],
    ["normal login", login, (response) => assert.deepEqual(response.result, [])],
    ["remembered login", remember, (response) => assert.equal(response.result[0].result, null)]
  ]) {
    await t.test(`${name}: five failures persist, then even the correct PIN is refused`, async () => {
      await resetAttempts();
      for (let count = 1; count <= 5; count++) {
        assertDenied(await call("000000"));
        const saved = await state();
        assert.equal(saved.failed_login_attempts, count);
        assert.equal(Boolean(saved.locked_until), count === 5);
      }
      await db.exec("reset role");
      const remaining = (await db.query(
        "select extract(epoch from (locked_until - now()))::float8 as seconds from public.agents where id = $1", [agentId]
      )).rows[0].seconds;
      assert.ok(remaining > 895 && remaining <= 900, "existing fifteen-minute duration is preserved");
      await db.exec("set role anon");
      const locked = await state();
      assertDenied(await call("123456"));
      assertDenied(await call("000000"));
      assert.deepEqual(await state(), locked, "locked requests neither reset nor extend the lock");
    });
  }

  await t.test("mixed RPC attempts share one counter and never create patrols", async () => {
    await resetAttempts();
    await login("000000"); await remember("000000"); await check("000000");
    assertHttpRefusal(await routes("000000"));
    assertHttpRefusal(await sync("000000", {})); // A bad payload cannot erase a failed authentication.
    assert.equal((await state()).failed_login_attempts, 5);
    assert.deepEqual((await login("123456")).result, []);
    await db.exec("reset role");
    assert.equal((await db.query("select count(*)::int as count from public.tours")).rows[0].count, 0);
    const other = (await db.query("select failed_login_attempts, locked_until from public.agents where badge = 'A2'")).rows[0];
    assert.deepEqual(other, { failed_login_attempts: 0, locked_until: null });
    await db.exec("set role anon");
  });
  await t.test("successful checks reset attempts and still load and synchronize valid data", async () => {
    await resetAttempts();
    await login("000000");
    assert.equal((await login("123456")).result[0].id, agentId);
    assert.equal((await state()).failed_login_attempts, 0);
    await login("000000");
    const response = await routes("123456");
    assert.equal(response.status, "200");
    assert.equal(response.result[0].result.length, 1);
    assert.equal((await state()).failed_login_attempts, 0);
    await login("000000");
    const saved = await sync("123456");
    assert.equal(saved.status, "200");
    assert.deepEqual(saved.result[0].result, { ok: true, tour_id: "own-tour" });
    assert.equal((await state()).failed_login_attempts, 0);
    assert.ok((await remember("123456")).result[0].result.token);
    assert.equal((await check("123456")).result[0].result, true);
  });
  await t.test("correct PIN works again after expiry and a manager PIN reset clears the lock", async () => {
    await resetAttempts();
    for (let count = 0; count < 5; count++) await login("000000");
    await db.exec("reset role");
    await db.query("update public.agents set locked_until = now() - interval '1 second' where id = $1", [agentId]);
    await db.exec("set role anon");
    assert.equal((await login("123456")).result[0].id, agentId);
    assert.equal((await state()).failed_login_attempts, 0);
    for (let count = 0; count < 5; count++) await login("000000");
    await db.exec(`set test.user_id = '${managerId}'; set role authenticated`);
    await db.query("select public.manager_reset_agent_pin($1, '654321')", [agentId]);
    await db.exec("set test.user_id = ''; set role anon");
    assert.equal((await login("654321")).result[0].id, agentId);
    assert.equal((await state()).locked_until, null);
    // Restore the fixture PIN for the remaining permission tests.
    await db.exec(`set test.user_id = '${managerId}'; set role authenticated`);
    await db.query("select public.manager_reset_agent_pin($1, '123456')", [agentId]);
    await db.exec("set test.user_id = ''; set role anon");
  });
  await t.test("ownership conflicts still roll back all tour changes after authentication", async () => {
    await resetAttempts();
    const own = payload("own-tour");
    own.comment = "Must not persist";
    own.incidents = [{ id: "other-agent-incident", category: "Incident", note: "Forbidden update" }];
    await db.exec("reset role");
    const otherAgent = (await db.query("select id from public.agents where badge = 'A2'")).rows[0].id;
    await db.query(`insert into public.tours(id,site_id,agent_id,agent_name,agent_badge,status,started_at)
      values ('other-tour',$1,$2,'Other Agent','A2','active',now())`, [siteId, otherAgent]);
    await db.query(`insert into public.incidents(id,tour_id,site_id,agent_id,category,note)
      values ('other-agent-incident','other-tour',$1,$2,'Incident','Original')`, [siteId, otherAgent]);
    const before = (await db.query("select * from public.tours where id = 'own-tour'")).rows;
    await db.exec("set role anon");
    await assert.rejects(sync("123456", own), /Incident belongs/);
    await db.exec("reset role");
    assert.deepEqual((await db.query("select * from public.tours where id = 'own-tour'")).rows, before);
    assert.equal((await db.query("select note from public.incidents where id = 'other-agent-incident'")).rows[0].note, "Original");
    await db.exec("set role anon");
  });
  await t.test("malformed PINs, inactive agents and stale epochs are refused", async () => {
    await resetAttempts();
    for (const pin of [null, "", "bad", "12345", "1234567", "123456\n"]) {
      assert.deepEqual((await login(pin)).result, []);
      assertHttpRefusal(await routes(pin));
      assertHttpRefusal(await sync(pin));
    }
    assert.equal((await state()).failed_login_attempts, 0);
    await db.exec("reset role");
    await db.query("update public.agents set active = false where id = $1", [agentId]);
    await db.exec("set role anon");
    assertHttpRefusal(await routes("123456"));
    assertHttpRefusal(await sync("123456"));
    await resetAttempts();
    await db.exec("reset role; update public.app_control set agent_session_epoch = gen_random_uuid(); set role anon");
    assertHttpRefusal(await routes("123456"));
    assertHttpRefusal(await sync("123456"));
    assert.equal((await state()).failed_login_attempts, 0);
    await assert.rejects(request("select public.sync_agent_tour_token($1, $2::jsonb)", [token, JSON.stringify(payload("stale"))]), /Agent session expired/);
  });
  await t.test("all internal PIN-based entry points remain inaccessible", async () => {
    for (const query of ["select public.authenticate_agent('A1','000000')",
      "select public.get_agent_route('A1','000000')", "select public.get_agent_routes('A1','000000')",
      "select public.sync_agent_tour('A1','000000','{}'::jsonb)",
      "select public.sync_agent_tour_for_site('A1','000000','{}'::jsonb)"]) {
      await assert.rejects(db.query(query), /permission denied/);
    }
    await assert.rejects(db.query("update public.agents set failed_login_attempts = 0"), /permission denied/);
  });
});
