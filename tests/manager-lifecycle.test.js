import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const source = (await readFile(new URL("../src/manager.js", import.meta.url), "utf8"))
  .replace(/^import \{[\s\S]*?from "\.\/managerRemoteStore.js(?:\?v=\d+)?";/, "")
  .replace("initialize();", "");
const session = { user: { email: "manager@example.test" } };
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

function setup() {
  const view = { innerHTML: "", dataset: {}, addEventListener() {}, querySelectorAll: () => [], querySelector: () => null };
  const timers = new Map();
  let timerId = 0;
  const context = vm.createContext({
    File, URL, atob,
    FormData: class { get(key) { return key === "email" ? session.user.email : "password"; } has() { return true; } },
    location: { hash: "#overview" },
    document: { getElementById: () => view, querySelector: () => ({}), querySelectorAll: () => [] },
    window: {
      addEventListener() {}, scrollTo() {},
      setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; },
      clearTimeout(id) { timers.delete(id); }
    },
    getManagerSession: async () => ({ ok: true, session }),
    verifyManagerAccess: async () => ({ ok: true, authorized: true }),
    signInManager: async () => ({ ok: true, session }),
    signOutManager: async () => ({ ok: true }),
    fetchManagerAgents: async () => ({ ok: true, agents: [] }),
    fetchManagerSites: async () => ({ ok: true, sites: [], checkpoints: [] }),
    fetchManagerTours: async () => ({ ok: true, tours: [] }),
    subscribeManagerUpdates: async () => { subscriptions++; return () => { stops++; }; }
  });
  let subscriptions = 0;
  let stops = 0;
  vm.runInContext(source, context);
  context.fixtureSession = session;
  context.form = { querySelector: () => ({ disabled: false, textContent: "" }) };
  context.logout = { target: { closest: () => ({ dataset: { action: "manager-signout" } }) } };
  return { context, view, timers, subscriptions: () => subscriptions, stops: () => stops };
}

test("fresh sign-in and saved-session restoration each start live updates", async () => {
  for (const entry of ["handleManagerLogin(form)", "initialize()"] ) {
    const { context, subscriptions } = setup();
    await vm.runInContext(entry, context);
    assert.equal(subscriptions(), 1);
  }
});

test("a dashboard response arriving after logout cannot restore private data", async () => {
  const { context, view } = setup();
  const pending = deferred();
  context.fetchManagerAgents = () => pending.promise;
  vm.runInContext("state.session = fixtureSession; state.sites = [{id:'private-site'}]; state.checkpoints = [{id:'private-qr'}]", context);
  const refresh = vm.runInContext("refreshDashboard(false)", context);
  await vm.runInContext("handleClick(logout)", context);
  pending.resolve({ ok: true, agents: [{ id: "private-agent", name: "Private agent" }] });
  await refresh;
  assert.match(view.innerHTML, /managerLoginForm/);
  assert.doesNotMatch(view.innerHTML, /Private agent/);
  assert.equal(vm.runInContext("state.agents.length + state.sites.length + state.checkpoints.length", context), 0);
});

test("responses from the previous login are ignored after another login", async () => {
  const { context } = setup();
  vm.runInContext("state.session = fixtureSession", context);
  const old = deferred();
  context.fetchManagerAgents = () => old.promise;
  const refresh = vm.runInContext("refreshDashboard(false)", context);
  await vm.runInContext("handleClick(logout)", context);
  context.fetchManagerAgents = async () => ({ ok: true, agents: [{ id: "new", name: "New session" }] });
  await vm.runInContext("handleManagerLogin(form)", context);
  old.resolve({ ok: true, agents: [{ id: "old", name: "Old session" }] });
  await refresh;
  assert.equal(vm.runInContext("state.agents[0].id", context), "new");
});

test("an older refresh cannot replace a newer response", async () => {
  const { context } = setup();
  vm.runInContext("state.session = fixtureSession", context);
  const old = deferred();
  context.fetchManagerAgents = () => old.promise;
  const refresh = vm.runInContext("refreshDashboard(false)", context);
  context.fetchManagerAgents = async () => ({ ok: true, agents: [{ id: "new", name: "New response" }] });
  await vm.runInContext("refreshDashboard(false)", context);
  old.resolve({ ok: true, agents: [{ id: "old", name: "Old response" }] });
  await refresh;
  assert.equal(vm.runInContext("state.agents[0].id", context), "new");
});

test("a subscription completing after logout is immediately closed", async () => {
  const { context } = setup();
  const pending = deferred();
  context.subscribeManagerUpdates = () => pending.promise;
  const activation = vm.runInContext("activateManagerSession(fixtureSession)", context);
  // Let the initial dashboard request finish and subscription setup begin.
  await new Promise((done) => setImmediate(done));
  await vm.runInContext("handleClick(logout)", context);
  let stopped = 0;
  pending.resolve(() => { stopped++; });
  await activation;
  assert.equal(stopped, 1);
});

test("queued live refreshes cannot run after logout", async () => {
  const { context, timers } = setup();
  vm.runInContext("state.session = fixtureSession; scheduleLiveRefresh()", context);
  const queued = [...timers.values()][0];
  await vm.runInContext("handleClick(logout)", context);
  let calls = 0;
  context.fetchManagerAgents = async () => { calls++; return { ok: true, agents: [] }; };
  queued();
  assert.equal(calls, 0);
});

test("failed logout restarts live updates while keeping the current session", async () => {
  const { context, subscriptions, stops } = setup();
  await vm.runInContext("handleManagerLogin(form)", context);
  context.signOutManager = async () => ({ ok: false });
  await vm.runInContext("handleClick(logout)", context);
  assert.equal(subscriptions(), 2);
  assert.equal(stops(), 1);
  assert.equal(vm.runInContext("state.session !== null", context), true);
});

test("rendering reuses management forms and restores focus without storing drafts", () => {
  const { context, view } = setup();
  const form = (id, attributes = {}, values = {}) => ({
    id, dataset: attributes, values,
    hasAttribute(name) { return name === "data-checkpoint-form" ? Boolean(attributes.siteId) : name === "data-pin-form" && Boolean(attributes.agentId); },
    replaceWith(previous) { view.forms[view.forms.indexOf(this)] = previous; }
  });
  const previous = [form("createAgentForm", {}, { name: "Draft", badge: "NEW-001", pin: "123456" }), form("createSiteForm", {}, { address: "Draft address" }), form("", { siteId: "site" }, { label: "Draft checkpoint" }), form("", { agentId: "agent" }, { newPin: "654321" })];
  view.forms = previous;
  view.querySelectorAll = (selector) => selector === "form" ? view.forms : [];
  Object.defineProperty(view, "innerHTML", { set() { view.forms = previous.map((item) => form(item.id, item.dataset)); } });
  let focused = false;
  let selection;
  context.document.activeElement = { selectionStart: 2, selectionEnd: 3, isConnected: true, closest: () => null, focus() { focused = true; }, setSelectionRange(...range) { selection = range; } };
  vm.runInContext("state.session = fixtureSession; renderDashboard()", context);
  previous.forEach((node, index) => assert.equal(view.forms[index], node));
  assert.equal(view.forms[0].values.name, "Draft");
  assert.equal(view.forms[3].values.newPin, "654321");
  assert.equal(focused, true);
  assert.deepEqual(selection, [2, 3]);
});

test("opening agent controls preserves an already expanded site panel", async () => {
  const { context, view } = setup();
  view.querySelectorAll = (selector) => selector === "details.site-row[open][data-site-panel-id]"
    ? [{ dataset: { sitePanelId: "site" } }] : [];
  context.toggle = { target: { closest: (selector) => ({ dataset: selector === "[data-action]" ? { action: "toggle-agent-panel" } : { agentPanelId: "agent" } }) } };
  vm.runInContext("state.session = fixtureSession", context);
  await vm.runInContext("handleClick(toggle)", context);
  assert.equal(vm.runInContext("state.expandedSiteIds.has('site')", context), true);
  assert.equal(vm.runInContext("state.expandedAgentIds.has('agent')", context), true);
});
