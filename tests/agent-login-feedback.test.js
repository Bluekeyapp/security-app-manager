import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createLocalDatabase } from "./helpers/local-database.js";

test("login feedback preserves authentication, counters and old clients", async (t) => {
  const db = await createLocalDatabase(t, { hardenOwnership: true });
  for (const name of ["agent-pin-attempts-hardening.sql", "agent-login-feedback.sql", "agent-login-feedback.sql"]) {
    await db.exec(await readFile(new URL(`../supabase/${name}`, import.meta.url), "utf8"));
  }
  await db.exec(`insert into public.agents (id, name, badge, pin_hash, all_sites_access)
    values ('test-agent', 'Agent', 'A1', extensions.crypt('123456', 'salt'), true);
    set role anon;`);
  const login = async (pin, remember = false, badge = "A1") => {
    await db.exec("begin");
    const result = (await db.query("select public.agent_login($1, $2, $3) as result", [badge, pin, remember])).rows[0].result;
    await db.exec("commit");
    return result;
  };
  for (const pin of [null, "", "123", "abcdef"]) {
    assert.deepEqual(await login(pin), { ok: false, reason: "invalid_credentials" });
  }
  assert.deepEqual(await login("123456", false, "unknown"), { ok: false, reason: "invalid_credentials" });
  for (let i = 1; i <= 5; i++) {
    const result = await login("000000", i % 2 === 0);
    if (i < 5) assert.deepEqual(result, { ok: false, reason: "invalid_credentials" });
    else {
      assert.equal(result.reason, "locked");
      assert.ok(result.retry_after_seconds > 895 && result.retry_after_seconds <= 900);
      assert.equal(result.agent, undefined);
    }
  }
  for (const remember of [false, true]) assert.equal((await login("123456", remember)).reason, "locked");
  await db.exec("reset role");
  assert.equal((await db.query("select failed_login_attempts from agents")).rows[0].failed_login_attempts, 5);
  assert.equal((await db.query("select count(*)::int as n from remembered_agent_sessions")).rows[0].n, 0);
  await db.exec("update agents set locked_until = now() + interval '61 seconds'; set role anon");
  const remaining = await login("123456");
  assert.ok(remaining.retry_after_seconds > 0 && remaining.retry_after_seconds <= 61);
  await db.exec("reset role; update agents set locked_until = now() - interval '1 second'; set role anon");
  const normal = await login("123456", false, " a1 ");
  assert.equal(normal.ok, true);
  assert.equal(normal.agent.id, "test-agent");
  assert.ok(normal.agent.session_epoch);
  assert.equal(normal.agent.token, undefined);
  const remembered = await login("123456", true);
  assert.match(remembered.agent.token, /^[0-9a-f]{64}$/);
  assert.equal((await db.query("select public.resume_remembered_agent_session($1) as a", [remembered.agent.token])).rows[0].a.id, "test-agent");
  assert.equal((await db.query("select * from public.authenticate_agent_session('A1', '123456')")).rows[0].id, "test-agent");
  await db.exec("reset role");
  assert.equal((await db.query("select failed_login_attempts from agents")).rows[0].failed_login_attempts, 0);
  await db.exec("update agents set active = false, locked_until = now() + interval '15 minutes'; set role anon");
  assert.deepEqual(await login("123456"), { ok: false, reason: "invalid_credentials" });
  await assert.rejects(db.query("select * from public.agents"), /permission denied/);
});
