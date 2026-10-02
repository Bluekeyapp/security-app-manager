import { test } from "node:test";
import assert from "node:assert/strict";
import { createManagerSessionStorage, MANAGER_AUTH_KEY, REMEMBER_MANAGER_KEY } from "../src/managerSessionStorage.js";

function area() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
}
function setup(local = area(), session = area()) {
  return { local, session, storage: createManagerSessionStorage({ local: () => local, session: () => session }) };
}
const token = JSON.stringify({ access_token: "access", refresh_token: "refresh" });

test("unchecked login survives reload but is absent from a new browser session", () => {
  const { local, session, storage } = setup();
  storage.setRemember(false);
  storage.setItem(MANAGER_AUTH_KEY, token);
  assert.equal(local.getItem(MANAGER_AUTH_KEY), null);
  assert.equal(setup(local, session).storage.getItem(MANAGER_AUTH_KEY), token);
  assert.equal(setup(local, area()).storage.getItem(MANAGER_AUTH_KEY), null);
});

test("remembered login resumes with a fresh session and stores refreshed tokens", () => {
  const { local, storage } = setup();
  storage.setRemember(true);
  storage.setItem(MANAGER_AUTH_KEY, token);
  const reopened = setup(local, area());
  assert.equal(reopened.storage.getItem(MANAGER_AUTH_KEY), token);
  reopened.storage.setItem(MANAGER_AUTH_KEY, "refreshed");
  assert.equal(setup(local, area()).storage.getItem(MANAGER_AUTH_KEY), "refreshed");
});

test("switching off remember clears the old durable session", () => {
  const { local, session, storage } = setup();
  storage.setRemember(true);
  storage.setItem(MANAGER_AUTH_KEY, token);
  storage.setRemember(false);
  storage.setItem(MANAGER_AUTH_KEY, "temporary");
  assert.equal(local.getItem(MANAGER_AUTH_KEY), null);
  assert.equal(local.getItem(REMEMBER_MANAGER_KEY), null);
  assert.equal(session.getItem(MANAGER_AUTH_KEY), "temporary");
});

test("sign out cleanup removes both sessions and remember preference", () => {
  const { local, session, storage } = setup();
  storage.setRemember(true);
  storage.setItem(MANAGER_AUTH_KEY, token);
  session.setItem(MANAGER_AUTH_KEY, "stale");
  storage.clear();
  assert.equal(local.getItem(MANAGER_AUTH_KEY), null);
  assert.equal(session.getItem(MANAGER_AUTH_KEY), null);
  assert.equal(local.getItem(REMEMBER_MANAGER_KEY), null);
  assert.equal(setup(local, area()).storage.getItem(MANAGER_AUTH_KEY), null);
});

test("legacy persistent sessions are not resumed without user opt-in", () => {
  const local = area();
  local.setItem(MANAGER_AUTH_KEY, token);
  const { storage } = setup(local);
  assert.equal(storage.getItem(MANAGER_AUTH_KEY), null);
  storage.setRemember(false);
  assert.equal(local.getItem(MANAGER_AUTH_KEY), null);
});

test("blocked storage supports temporary login but rejects a promise to remember", () => {
  const blocked = { getItem() { throw Error("blocked"); }, setItem() { throw Error("blocked"); }, removeItem() { throw Error("blocked"); } };
  const { storage } = setup(blocked, blocked);
  storage.setRemember(false);
  storage.setItem(MANAGER_AUTH_KEY, token);
  assert.equal(storage.getItem(MANAGER_AUTH_KEY), token);
  assert.throws(() => storage.setRemember(true), /blocked/);
  storage.clear();
  assert.equal(storage.getItem(MANAGER_AUTH_KEY), null);
});
