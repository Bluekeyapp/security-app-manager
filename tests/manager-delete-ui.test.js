import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const source = (await readFile(new URL("../src/manager.js", import.meta.url), "utf8"))
  .replace(/^import \{[\s\S]*?from "\.\/managerRemoteStore.js(?:\?v=\d+)?";/, "")
  .replace("initialize();", "");

function setup(confirm, result = { ok: true }, historyResult = { ok: true, deletedCount: 2 }) {
  const view = { innerHTML: "", dataset: {}, addEventListener() {}, querySelectorAll: () => [], querySelector: () => null };
  const calls = [];
  const historyCalls = [];
  const agent = { id: "a", name: "Agent Test", badge: "001", site_id: "s", active: true };
  const context = vm.createContext({
    File, URL, atob,
    location: { hash: "#overview" },
    document: { getElementById: () => view, querySelector: () => ({}), querySelectorAll: () => [] },
    window: { confirm, clearTimeout, setTimeout, addEventListener() {}, scrollTo() {} },
    clearManagerActivityHistory: async () => { historyCalls.push(true); return historyResult; },
    deleteManagedItem: async (...args) => { calls.push(args); return result; },
    fetchManagerAgents: async () => ({ ok: true, agents: [] }),
    fetchManagerSites: async () => ({ ok: true, sites: [], checkpoints: [] }),
    fetchManagerTours: async () => ({ ok: true, tours: [] })
  });
  vm.runInContext(source, context);
  context.fixture = agent;
  vm.runInContext("state.agents = [fixture]; state.sites = [{id:'s',name:'Test Site'}]", context);
  const button = { dataset: { action: "delete-agent", id: "a" }, disabled: false };
  context.button = button;
  return { context, calls, historyCalls, view, button };
}

test("category navigation shows only its panel and overview restores all panels", () => {
  const { context, view } = setup(() => false);
  const panels = ['sites', 'agents', 'reports', 'journal'].map((name) => ({ dataset: { categoryPanel: name }, hidden: false }));
  const metrics = { hidden: false };
  view.querySelectorAll = () => panels;
  view.querySelector = () => metrics;
  context.location.hash = '#reports';
  vm.runInContext('applyCategory()', context);
  assert.deepEqual(panels.map((panel) => panel.hidden), [true, true, false, true]);
  assert.equal(metrics.hidden, true);
  assert.equal(view.textContent, 'Rapports clients');
  context.location.hash = '#overview';
  vm.runInContext('applyCategory()', context);
  assert.ok(panels.every((panel) => !panel.hidden));
  assert.equal(metrics.hidden, false);
  context.location.hash = '#unknown';
  vm.runInContext('applyCategory()', context);
  assert.equal(view.dataset.category, 'overview');
});

test("QR download generates PNG with a four-module quiet zone and matching filename", async () => {
  const { context } = setup(() => false);
  const nodes = {};
  let opened = false;
  const rects = [];
  const canvas = {
    getContext: () => ({ fillRect: (...args) => rects.push(args) }),
    toDataURL: (type) => { assert.equal(type, "image/png"); return "data:image/png;base64,test"; }
  };
  context.document.createElement = (tag) => { assert.equal(tag, "canvas"); return canvas; };
  context.document.getElementById = (id) => nodes[id] ||= { removeAttribute() {}, showModal: () => { opened = true; } };
  context.window.qrcode = () => ({ addData() {}, make() {}, getModuleCount: () => 21, isDark: () => true });
  vm.runInContext("state.checkpoints = [{id:'p',site_id:'s',label:'Poste A',qr_payload:'test'}]; showQrCode('p')", context);
  assert.equal(canvas.width, 232);
  assert.equal(canvas.height, 232);
  assert.deepEqual(rects[1], [32, 32, 8, 8]);
  assert.equal(nodes.qrDownloadButton.download, "test-site-poste-a.png");
  assert.match(nodes.qrDownloadButton.href, /^blob:/);
  assert.match(nodes.qrDialogImage.src, /^data:image\/png/);
  assert.equal(opened, true);
  const html = await readFile(new URL("../manager.html", import.meta.url), "utf8");
  assert.match(html, /id="qrDownloadButton" download target="_blank" rel="noopener">Télécharger<\/a>/);
  assert.match(html, /id="qrPrintButton" target="_blank" rel="noopener"/);
  assert.doesNotMatch(html, /onclick="window.print\(\)"/);
  vm.runInContext("clearQrOutput()", context);
});

test("QR actions use mobile file sharing without delaying user activation", async () => {
  const { context } = setup(() => false);
  const nodes = { qrDialogTitle: { textContent: "Poste A" }, qrOutputStatus: {}, qrOutputFallback: {} };
  context.document.getElementById = (id) => nodes[id];
  context.window.matchMedia = () => ({ matches: true });
  let shared;
  context.navigator = { canShare: () => true, share: (data) => { shared = data; return Promise.resolve(); } };
  const attrs = {};
  context.link = { getAttribute: (key) => attrs[key], setAttribute: (key, value) => attrs[key] = value, removeAttribute: (key) => delete attrs[key] };
  context.file = new File(["png"], "point.png", { type: "image/png" });
  vm.runInContext("configureQrAction(link, file, 'blob:test')", context);
  let prevented = false;
  const pending = context.link.onclick({ preventDefault() { prevented = true; } });
  assert.equal(shared.files[0], context.file);
  assert.equal(prevented, true);
  await pending;
  assert.equal(attrs["aria-busy"], undefined);
  context.navigator.share = async () => { throw Object.assign(new Error(), { name: "AbortError" }); };
  await context.link.onclick({ preventDefault() {} });
  assert.equal(nodes.qrOutputFallback.hidden, true);
  context.navigator.share = async () => { throw new Error("unsupported"); };
  await context.link.onclick({ preventDefault() {} });
  assert.equal(nodes.qrOutputFallback.hidden, false);
  assert.equal(nodes.qrOutputFallback.href, "blob:test");
  for (const mobile of [false, true]) {
    context.window.matchMedia = () => ({ matches: mobile });
    context.navigator.canShare = () => false;
    await context.link.onclick({ preventDefault() { assert.fail("Browser file fallback must remain clickable"); } });
  }
});

test("cancelling deletion leaves the agent untouched", async () => {
  const { context, calls, button } = setup(() => false);
  await vm.runInContext("handleDelete(button)", context);
  assert.equal(calls.length, 0);
  assert.equal(button.disabled, false);
});

test("confirmed deletion refreshes the list and shows success", async () => {
  const { context, calls, view } = setup((message) => {
    assert.match(message, /Agent Test/);
    assert.match(message, /conservés/);
    return true;
  });
  await vm.runInContext("handleDelete(button)", context);
  assert.deepEqual(calls, [["agent", "a"]]);
  assert.match(view.innerHTML, /Agent supprimé/);
  assert.doesNotMatch(view.innerHTML, /data-id="a"/);
});

test("database failures remain visible without removing the row", async () => {
  const { context, view } = setup(() => true, { ok: false, error: { message: "Active patrol prevents deletion" } });
  vm.runInContext("state.expandedAgentIds.add('a')", context);
  await vm.runInContext("handleDelete(button)", context);
  assert.match(view.innerHTML, /Terminez ou annulez/);
  assert.match(view.innerHTML, /data-id="a"/);
});

test("double clicks cannot submit the same deletion twice", async () => {
  const { context, calls } = setup(() => true);
  await vm.runInContext("Promise.all([handleDelete(button), handleDelete(button)])", context);
  assert.equal(calls.length, 1);
});

test("activity journal offers an in-app protected global deletion", async () => {
  const { context, historyCalls, view } = setup(() => false);
  vm.runInContext("state.tours = [{id:'one',status:'completed'},{id:'two',status:'cancelled'}]", context);
  const html = vm.runInContext("renderDashboard(); managerView.innerHTML", context);
  assert.match(html, /data-action="clear-activity-history"/);
  context.clearButton = { closest: () => ({ dataset: { action: "clear-activity-history" } }) };
  await vm.runInContext("handleClick({target: clearButton})", context);
  assert.match(view.innerHTML, /role="dialog"/);
  assert.match(view.innerHTML, /Effacer définitivement/);
  assert.match(view.innerHTML, /sessions agent/i);
  assert.equal(historyCalls.length, 0);

  context.cancelButton = { closest: () => ({ dataset: { action: "cancel-clear-activity-history" } }) };
  await vm.runInContext("handleClick({target: cancelButton})", context);
  assert.doesNotMatch(view.innerHTML, /role="dialog"/);

  await vm.runInContext("handleClick({target: clearButton})", context);
  context.confirmButton = { closest: () => ({ dataset: { action: "confirm-clear-activity-history" } }) };
  await vm.runInContext("handleClick({target: confirmButton})", context);
  assert.equal(historyCalls.length, 1);
  assert.match(view.innerHTML, /2 activités supprimées/);
});

test("activity journal erasure includes active patrols", async () => {
  const { context, historyCalls, view } = setup(() => true);
  vm.runInContext("state.tours = [{id:'active',status:'active'}]", context);
  context.historyButton = { disabled: false };
  await vm.runInContext("handleClearActivityHistory(historyButton)", context);
  assert.equal(historyCalls.length, 1);
  assert.match(view.innerHTML, /2 activités supprimées/);
});

test("activity journal button recovers after a Supabase failure", async () => {
  const { context, view } = setup(() => true, { ok: true }, { ok: false, error: { code: "42501", message: "Manager access required" } });
  vm.runInContext("state.tours = [{id:'one',status:'completed'}]", context);
  await vm.runInContext("handleClearActivityHistory()", context);
  assert.doesNotMatch(view.innerHTML, /Suppression\.\.\./);
  assert.match(view.innerHTML, /Une erreur est survenue \(42501\)/);
  assert.match(view.innerHTML, /data-action="clear-activity-history"/);
});

test("departure QR can be deleted and has no deactivate control", () => {
  const { context } = setup(() => false);
  const html = vm.runInContext("renderCheckpointRow({id:'start',label:'Poste A',kind:'start',active:true})", context);
  assert.match(html, /delete-checkpoint/);
  assert.doesNotMatch(html, /toggle-checkpoint/);
});

test("expanded site and agent panels remain open after rendering", () => {
  const { context } = setup(() => false);
  vm.runInContext(`
    state.agents = [fixture];
    state.sites = [{id:'s',name:'Test Site',address:'',active:true}];
    state.checkpoints = [];
    state.expandedSiteIds.add('s');
    state.expandedAgentIds.add('a');
  `, context);

  const html = vm.runInContext("renderDashboard(); managerView.innerHTML", context);
  assert.match(html, /data-site-panel-id="s" open/);
  assert.match(html, /data-agent-panel-id="a" aria-expanded="true"/);
  assert.match(html, /agent-manage-actions/);
});

test("agent management toggle keeps the status and button in the primary row", () => {
  const { context } = setup(() => false);
  const closedHtml = vm.runInContext("renderAgentRow(fixture)", context);
  assert.match(closedHtml, /agent-state active/);
  assert.match(closedHtml, /agent-manage-toggle/);
  assert.doesNotMatch(closedHtml, /agent-manage-actions/);

  vm.runInContext("state.expandedAgentIds.add('a')", context);
  const openHtml = vm.runInContext("renderAgentRow(fixture)", context);
  assert.match(openHtml, /aria-expanded="true"/);
  assert.match(openHtml, /agent-manage-actions/);
});

test("agents have no site assignment controls", () => {
  const { context } = setup(() => false);
  vm.runInContext("state.expandedAgentIds.add('a')", context);
  const html = vm.runInContext("renderAgentRow(fixture)", context);
  assert.match(html, /Tous les sites/);
  assert.doesNotMatch(html, /data-agent-access-form|allSitesAccess|Choisir un site/);
});

test("clicking the agent management button opens and closes its actions", async () => {
  const { context, view } = setup(() => false);
  const target = {
    dataset: { action: "toggle-agent-panel", agentPanelId: "a" },
    closest() { return this; }
  };
  context.toggleTarget = target;

  await vm.runInContext("handleClick({target: toggleTarget})", context);
  assert.match(view.innerHTML, /aria-expanded="true"/);
  assert.match(view.innerHTML, /agent-manage-actions/);

  await vm.runInContext("handleClick({target: toggleTarget})", context);
  assert.match(view.innerHTML, /aria-expanded="false"/);
  assert.doesNotMatch(view.innerHTML, /agent-manage-actions/);
});

test("completed tours with incidents use the incident status style", () => {
  const { context } = setup(() => false);
  const tour = {
    id: "tour-1",
    status: "completed",
    startedAt: "2026-09-22T00:00:00Z",
    completedAt: "2026-09-22T00:10:00Z",
    agentName: "Agent Test",
    agentBadge: "001",
    incidents: [{ id: "incident-1", category: "Incident", createdAt: "2026-09-22T00:05:00Z" }],
    scans: []
  };
  context.tourFixture = tour;

  const html = vm.runInContext("renderTourCard(tourFixture)", context);
  assert.match(html, /tour-status completed has-incidents/);
  assert.match(html, />Terminée<\/span>/);
});

test("today period starts at local midnight instead of using a rolling 24 hours", () => {
  const { context } = setup(() => false);
  vm.runInContext(`
    state.periodFilter = '1';
    state.tours = [
      {id:'yesterday',status:'completed',startedAt:new Date(2026,8,21,23,59,59).toISOString()},
      {id:'today',status:'completed',startedAt:new Date(2026,8,22,0,0,0).toISOString()}
    ];
  `, context);

  const ids = vm.runInContext("getVisibleTours(new Date(2026,8,22,0,1,0)).map((tour) => tour.id).join(',')", context);
  assert.equal(ids, "today");
});

test("seven-day period includes today and the six preceding calendar days", () => {
  const { context } = setup(() => false);
  const cutoff = vm.runInContext("getPeriodCutoff('7', new Date(2026,8,22,12,0,0))", context);
  const expected = vm.runInContext("new Date(2026,8,16,0,0,0).getTime()", context);
  assert.equal(cutoff, expected);
});

test("site configuration no longer includes PDF report controls", () => {
  const { context } = setup(() => false);
  const html = vm.runInContext("renderSiteRow({id:'s',name:'Test Site',address:'Rue Test',active:true})", context);
  assert.doesNotMatch(html, /export-site-report|data-report-form|name="from"|Rapport PDF/);
  assert.match(html, /delete-site/);
});

test("client reports panel includes activity and signalement reports", () => {
  const { context } = setup(() => false);
  const html = vm.runInContext("renderCategoryReportsPanel()", context);
  assert.match(html, /Rapports clients/);
  assert.match(html, /Rapport d(?:'|&#039;)activité/);
  assert.match(html, /Signalements/);
  assert.match(html, /data-report-type="activity"/);
  assert.match(html, /data-report-type="incidents"/);
  assert.equal((html.match(/data-action="export-client-report"/g) || []).length, 1);
  const incidents = vm.runInContext("state.reportType = 'incidents'; renderCategoryReportsPanel()", context);
  assert.match(incidents, /Rapport de signalements/);
  assert.match(incidents, /data-action="export-client-report" data-report-type="incidents"/);
});

test("signalement reports retain only patrols containing incidents", () => {
  const { context } = setup(() => false);
  context.categoryTours = [
    { id: "mixed", status: "completed", incidents: [{ category: "Urgence" }, { category: "Matériel" }] },
    { id: "ordinary", status: "completed", incidents: [{ category: "Incident" }] },
    { id: "empty", status: "completed", incidents: [] }
  ];
  const result = vm.runInContext("filterIncidentTours(categoryTours)", context);
  assert.deepEqual(result.map((tour) => tour.id), ["mixed", "ordinary"]);
  assert.equal(result[0].incidents.length, 2);
});

test("signalement PDF uses its site, dates and newest-first order", async () => {
  const { context } = setup(() => false);
  const calls = [];
  context.fetchSiteReportTours = async (...args) => { calls.push(args); return { ok: true, tours: [
    { id: "ignored", site_id: "s", status: "completed", started_at: "2026-09-23T10:00:00Z", tour_scans: [], incidents: [] },
    { id: "older", site_id: "s", status: "completed", started_at: "2026-09-20T10:00:00Z", tour_scans: [], incidents: [{ category: "Urgence" }] },
    { id: "newer", site_id: "s", status: "completed", started_at: "2026-09-22T10:00:00Z", tour_scans: [], incidents: [{ category: "Incident" }] }
  ] }; };
  context.window.jspdf = { jsPDF: class { save(name) { calls.push(name); } } };
  const order = [];
  context.recordCategory = (tours, options) => { order.push(...tours.map((tour) => tour.id), options.reportLabel, options.incidentOnly); };
  vm.runInContext("buildSiteReportPdf = (_, __, tours, ___, ____, _____, options) => recordCategory(tours, options)", context);
  const values = { siteId: "s", from: "2026-09-20", to: "2026-09-22" };
  const form = { dataset: {reportType:"incidents"}, querySelector: (selector) => ({ value: values[selector.match(/name="([^"]+)/)[1]] }) };
  context.categoryButton = { textContent: "Rapport PDF", disabled: false, closest: () => form };
  await vm.runInContext("exportClientReport(categoryButton)", context);
  assert.equal(calls[0][0], "s");
  assert.deepEqual(order, ["newer", "older", "Rapport de signalements", true]);
  assert.match(calls[1], /test-site-signalements-2026-09-20_2026-09-22\.pdf/);
});

test("activity and signalement reports keep independent date ranges", () => {
  const { context } = setup(() => false);
  vm.runInContext("state.clientReports.activity.from='2026-09-01'; state.clientReports.incidents.from='2026-09-15'", context);
  const html = vm.runInContext("renderCategoryReportsPanel()", context);
  assert.match(html, /data-report-type="activity"[\s\S]*value="2026-09-01"/);
  const incidents = vm.runInContext("state.reportType='incidents'; renderCategoryReportsPanel()", context);
  assert.match(incidents, /data-report-type="incidents"[\s\S]*value="2026-09-15"/);
});

test("report dates reject impossible dates and include the full end day", async () => {
  const { context } = setup(() => false);
  assert.equal(vm.runInContext("parseReportDate('2026-02-30')", context), null);
  assert.equal(vm.runInContext("parseReportDate('2026-09-22') instanceof Date", context), true);

  const calls = [];
  context.fetchSiteReportTours = async (...args) => { calls.push(args); return {ok:true,tours:[]}; };
  context.window.jspdf = { jsPDF: class {
    constructor() { this.internal={pageSize:{getWidth:()=>210,getHeight:()=>297}}; }
    setFillColor(){} rect(){} setFont(){} setFontSize(){} setTextColor(){}
    text(){} roundedRect(){} getNumberOfPages(){return 1;} setPage(){}
    save(name){ calls.push(name); }
  }};
  const form = {dataset:{reportType:'activity'},querySelector: (selector) => ({value: selector === '[name="siteId"]' ? 's' : selector === '[name="from"]' ? '2026-09-21' : '2026-09-22'})};
  context.reportButton = {textContent:'Rapport PDF',disabled:false,closest:()=>form};
  await vm.runInContext("exportClientReport(reportButton)",context);
  assert.equal(calls.length,2);
  assert.equal(calls[0][0],'s');
  assert.equal(new Date(calls[0][1]).getDate(),21);
  assert.equal(new Date(calls[0][2]).getDate(),23);
  assert.match(calls[1], /2026-09-21_2026-09-22/);
});

test("PDF report lists the newest patrol first", async () => {
  const { context } = setup(() => false);
  context.fetchSiteReportTours = async () => ({ok:true,tours:[
    {id:'older',site_id:'s',started_at:'2026-09-21T10:00:00Z',tour_scans:[],incidents:[]},
    {id:'newer',site_id:'s',started_at:'2026-09-22T10:00:00Z',tour_scans:[],incidents:[]}
  ]});
  context.window.jspdf = {jsPDF:class {save(){}}};
  const order = [];
  context.recordOrder = (tours) => order.push(...tours.map((tour) => tour.id));
  vm.runInContext('buildSiteReportPdf = (_, __, tours) => recordOrder(tours)', context);
  const form = {dataset:{reportType:'activity'},querySelector: (selector) => ({value: selector === '[name="siteId"]' ? 's' : selector === '[name="from"]' ? '2026-09-21' : '2026-09-22'})};
  context.reportButton = {textContent:'Rapport PDF',disabled:false,closest:()=>form};
  await vm.runInContext('exportClientReport(reportButton)',context);
  assert.deepEqual(order,['newer','older']);
});

test("client report date changes survive dashboard refreshes", () => {
  const { context, view } = setup(() => false);
  const panel = {
    dataset: {reportType:'activity'},
    querySelector: (selector) => ({value: selector === '[name="siteId"]' ? 's' : selector === '[name="from"]' ? '2026-09-20' : '2026-09-22'})
  };
  context.dateTarget = {closest: () => panel};
  vm.runInContext('handleChange({target:dateTarget})', context);
  assert.equal(vm.runInContext("state.clientReports.activity.from", context), '2026-09-20');
  view.querySelectorAll = (selector) => selector === '[data-client-report-form]' ? [panel] : [];
  vm.runInContext('captureExpandedPanels()', context);
  assert.equal(vm.runInContext("state.clientReports.activity.to", context), '2026-09-22');
});

test("PDF map links include scan coordinates", () => {
  const { context } = setup(() => false);
  const url = vm.runInContext("getGoogleMapsUrl({lat:17.9,lng:-62.8,accuracy:9})", context);
  assert.equal(url, "https://www.google.com/maps?q=17.9%2C-62.8");
});
