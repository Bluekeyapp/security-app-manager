import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createLocalDatabase } from "./helpers/local-database.js";

const managerId = "00000000-0000-0000-0000-000000000010";
const siteId = "00000000-0000-0000-0000-000000000001";
const photo = "data:image/jpeg;base64,dGVzdA==";
const tour = (id, options = {}) => ({
  id, siteId, status: "active", startedAt: "2026-10-05T12:00:00Z", comment: "Original comment",
  scans: [{ id: `${id}-start`, pointId: "post-a", type: "start",
    scannedAt: "2026-10-05T12:00:00Z", gps: { lat: 18, lng: -63, accuracy: 5 } }],
  incidents: [{ id: `${id}-incident`, category: "Incident", note: "Original note", photoData: photo,
    createdAt: "2026-10-05T12:01:00Z" }],
  ...options
});

test("tour synchronization enforces ownership without losing legitimate updates", async (t) => {
  const db = await createLocalDatabase(t);
  await db.exec(`insert into public.manager_users values ('${managerId}', now());
    set test.user_id = '${managerId}'; set role authenticated;`);
  for (const badge of ["A1", "A2"]) {
    await db.query("select * from public.manager_create_agent('Test Agent', $1, '123456', null, true)", [badge]);
  }
  const secondSite = (await db.query("select id from public.manager_create_site('Second site', '')")).rows[0].id;
  await db.exec("set test.user_id = ''; set role anon");
  const credentials = {};
  for (const badge of ["A1", "A2"]) {
    const agent = (await db.query("select * from public.authenticate_agent_session($1, '123456')", [badge])).rows[0];
    const session = (await db.query("select public.create_remembered_agent_session($1, '123456') as session", [badge])).rows[0].session;
    credentials[badge] = { agentId: agent.id, epoch: agent.session_epoch, token: session.token };
  }
  const send = async (mode, badge, payload) => {
    const session = credentials[badge];
    const result = mode === "pin"
      ? await db.query("select public.sync_agent_tour_session($1, '123456', $2, $3::jsonb) as result",
        [badge, session.epoch, JSON.stringify(payload)])
      : await db.query("select public.sync_agent_tour_token($1, $2::jsonb) as result", [session.token, JSON.stringify(payload)]);
    return result.rows[0].result;
  };
  const snapshot = async () => {
    await db.exec("reset role");
    const result = {};
    for (const table of ["tours", "tour_scans", "incidents"]) {
      result[table] = (await db.query(`select * from public.${table} order by id`)).rows;
    }
    result.agents = (await db.query("select id, site_id from public.agents order by id")).rows;
    await db.exec("set role anon");
    return result;
  };
  const denied = async (mode, badge, payload, message) => {
    const before = await snapshot();
    await assert.rejects(send(mode, badge, payload), (error) => error.code === "42501" && message.test(error.message));
    assert.deepEqual(await snapshot(), before, "a rejected write must roll back all changes");
  };

  const victim = tour("victim");
  await send("token", "A1", victim);
  await t.test("the historical synchronizers reproduce the cross-agent collision", async () => {
    for (const mode of ["pin", "token"]) {
      const attack = tour(`historical-${mode}`);
      attack.scans[0].id = victim.scans[0].id;
      attack.scans[0].gps.lat = 99;
      attack.incidents[0].id = victim.incidents[0].id;
      attack.incidents[0].note = "Overwritten by another agent";
      await send(mode, "A2", attack);
      const state = await snapshot();
      assert.equal(state.tour_scans.find((row) => row.id === victim.scans[0].id).gps_lat, 99);
      assert.equal(state.incidents.find((row) => row.id === victim.incidents[0].id).note, attack.incidents[0].note);
      await send("token", "A1", victim);
    }
  });

  const beforeMigration = await snapshot();
  await db.exec("reset role");
  const migration = await readFile(new URL("../supabase/tour-write-ownership-hardening.sql", import.meta.url), "utf8");
  await db.exec(migration);
  await db.exec(migration);
  await db.exec("set role anon");
  assert.deepEqual(await snapshot(), beforeMigration, "migration preserves every existing record");

  for (const mode of ["pin", "token"]) {
    await t.test(`${mode}: another agent cannot reuse a scan identifier`, async () => {
      const attack = tour(`scan-attack-${mode}`);
      attack.scans[0].id = victim.scans[0].id;
      attack.scans[0].gps.lat = 99;
      await denied(mode, "A2", attack, /Scan belongs/);
    });
    await t.test(`${mode}: another agent cannot replace an incident's note or photo`, async () => {
      const attack = tour(`incident-attack-${mode}`);
      attack.incidents[0] = { ...attack.incidents[0], id: victim.incidents[0].id,
        note: "Changed note", photoData: "data:image/jpeg;base64,YXR0YWNr" };
      await denied(mode, "A2", attack, /Incident belongs/);
    });
    await t.test(`${mode}: the same agent cannot reuse children from another tour`, async () => {
      const attack = tour(`same-owner-${mode}`);
      attack.scans[0].id = victim.scans[0].id;
      await denied(mode, "A1", attack, /Scan belongs/);
      attack.scans[0].id = `same-owner-${mode}-new-start`;
      attack.incidents[0].id = victim.incidents[0].id;
      await denied(mode, "A1", attack, /Incident belongs/);
    });
    await t.test(`${mode}: existing tour ownership cannot be changed`, async () => {
      await denied(mode, "A2", structuredClone(victim), /Tour belongs/);
      await denied(mode, "A1", { ...structuredClone(victim), siteId: secondSite }, /Tour belongs/);
    });
    await t.test(`${mode}: an incident conflict rolls back earlier updates and inserts`, async () => {
      const own = tour(`partial-${mode}`);
      await send(mode, "A2", own);
      const attack = structuredClone(own);
      attack.comment = "Must roll back";
      attack.scans[0].gps.lat = 55;
      attack.incidents[0].note = "Must also roll back";
      attack.incidents.push({ ...victim.incidents[0], note: "Forbidden last write" });
      await denied(mode, "A2", attack, /Incident belongs/);
    });
    await t.test(`${mode}: truncation cannot bypass child ownership`, async () => {
      const longVictim = tour(`long-${mode}`);
      longVictim.scans[0].id = `scan-${mode}-`.padEnd(100, "x");
      longVictim.incidents[0].id = `incident-${mode}-`.padEnd(100, "x");
      await send(mode, "A1", longVictim);
      const attack = tour(`long-attack-${mode}`);
      attack.scans[0].id = `${longVictim.scans[0].id}-different`;
      await denied(mode, "A2", attack, /Scan belongs/);
      attack.scans[0].id = `long-attack-${mode}-start`;
      attack.incidents[0].id = `${longVictim.incidents[0].id}-different`;
      await denied(mode, "A2", attack, /Incident belongs/);
    });
    await t.test(`${mode}: retrying and completing an owned tour remains idempotent`, async () => {
      const own = tour(`legitimate-${mode}`);
      await send(mode, "A1", own);
      await send(mode, "A1", own); // Server accepted a write but the client lost its response.
      own.comment = "Updated comment";
      own.scans[0].gps.lat = 19;
      own.incidents[0].note = "Updated note";
      own.incidents[0].photoData = "data:image/jpeg;base64,dXBkYXRlZA==";
      own.status = "completed";
      own.completedAt = "2026-10-05T12:10:00Z";
      for (const point of ["checkpoint-1", "checkpoint-2", "checkpoint-3"]) {
        own.scans.push({ id: `${own.id}-${point}`, pointId: point, type: "checkpoint", scannedAt: own.completedAt });
      }
      own.scans.push({ id: `${own.id}-close`, pointId: "post-a", type: "close", scannedAt: own.completedAt });
      assert.deepEqual(await send(mode, "A1", own), { ok: true, tour_id: own.id });
      await send(mode, "A1", own);
      const state = await snapshot();
      const saved = state.tours.filter((row) => row.id === own.id);
      assert.equal(saved.length, 1);
      assert.equal(saved[0].status, "completed");
      assert.equal(saved[0].comment, "Updated comment");
      assert.equal(state.tour_scans.filter((row) => row.tour_id === own.id).length, 5);
      assert.equal(state.tour_scans.find((row) => row.id === own.scans[0].id).gps_lat, 19);
      const incidents = state.incidents.filter((row) => row.tour_id === own.id);
      assert.equal(incidents.length, 1);
      assert.equal(incidents[0].note, "Updated note");
      assert.equal(incidents[0].photo_data, own.incidents[0].photoData);
    });
  }

  await t.test("direct synchronizer and table writes stay inaccessible to agents", async () => {
    await assert.rejects(db.query("select public.sync_agent_tour('A1', '123456', '{}'::jsonb)"), /permission denied/);
    await assert.rejects(db.query("update public.incidents set note = 'Forbidden'"), /permission denied/);
    await assert.rejects(db.query("update public.tour_scans set gps_lat = 99"), /permission denied/);
  });
  await t.test("NULL PINs and expired sessions remain denied after the ownership migration", async () => {
    const payload = JSON.stringify(tour("expired"));
    await assert.rejects(db.query("select public.sync_agent_tour_session('A1', null, $1, $2::jsonb)",
      [credentials.A1.epoch, payload]), /Agent session expired/);
    await db.exec("reset role; update public.app_control set agent_session_epoch = gen_random_uuid(); set role anon");
    for (const mode of ["pin", "token"]) {
      const before = await snapshot();
      await assert.rejects(send(mode, "A1", tour(`expired-${mode}`)), /Agent session expired/);
      assert.deepEqual(await snapshot(), before);
    }
  });
});
