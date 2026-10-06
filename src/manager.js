import {
  createManagedAgent,
  createManagedCheckpoint,
  createManagedStartingPost,
  createManagedSite,
  clearManagerActivityHistory,
  deleteManagedItem,
  fetchManagerAgents,
  fetchManagerSites,
  fetchSiteReportTours,
  fetchManagerTours,
  getManagerSession,
  resetManagedAgentPin,
  setManagedAgentActive,
  signInManager,
  signOutManager,
  subscribeManagerUpdates,
  verifyManagerAccess
} from "./managerRemoteStore.js?v=2";

const managerView = document.getElementById("managerView");
// Published routes use a base URL for assets; navigation must stay on the manager page.
for (const link of document.querySelectorAll(".manager-navigation a")) {
  link.href = `${location.pathname}${location.search}${link.getAttribute("href")}`;
}
const categories = { overview: "Vue d'ensemble", sites: "Sites et QR codes", agents: "Agents", reports: "Rapports clients", journal: "Journal d'activité" };
const state = {
  session: null,
  agents: [],
  tours: [],
  sites: [],
  checkpoints: [],
  reportType: "activity",
  agentFormOpen: false,
  siteFormOpen: false,
  expandedAgentIds: new Set(),
  expandedSiteIds: new Set(),
  clientReports: {
    activity: { siteId: "", from: "", to: "" },
    incidents: { siteId: "", from: "", to: "" }
  },
  tourFilter: "all",
  periodFilter: "30",
  clearHistoryConfirmOpen: false,
  lastUpdated: null,
  message: "",
  error: ""
};
let deletionPending = false;
let stopLiveUpdates = null;
let liveRefreshTimer = null;
let periodRolloverTimer = null;
let sessionGeneration = 0;
let refreshSequence = 0;
let signingOut = false;
const bannerTimers = new Map();

managerView.addEventListener("submit", handleSubmit);
managerView.addEventListener("click", handleClick);
managerView.addEventListener("change", handleChange);
const accountDialog = document.getElementById("managerAccountDialog");
const accountButton = document.getElementById("managerAccountButton");
accountButton?.addEventListener?.("click", () => {
  if (!state.session || signingOut) return;
  updateAccountActions();
  accountDialog.showModal();
  accountButton.setAttribute("aria-expanded", "true");
  document.body.classList.add("account-dialog-open");
});
accountDialog?.addEventListener?.("click", (event) => {
  if (event.target === accountDialog || event.target.closest('[data-action="close-account"]')) {
    closeAccountDialog();
  } else if (event.target.closest("[data-action]")) {
    closeAccountDialog(true);
    handleClick(event);
  }
});
accountDialog?.addEventListener?.("cancel", (event) => {
  event.preventDefault();
  closeAccountDialog();
});
accountDialog?.addEventListener?.("close", () => {
  accountDialog.classList.remove("is-closing");
  accountButton.setAttribute("aria-expanded", "false");
  document.body.classList.remove("account-dialog-open");
});

function closeAccountDialog(immediate = false) {
  if (!accountDialog?.open) return;
  if (immediate) {
    accountDialog.close();
  } else if (!accountDialog.classList.contains("is-closing")) {
    accountDialog.classList.add("is-closing");
    window.setTimeout(() => accountDialog.close(), 180);
  }
}

function updateAccountActions() {
  const clear = accountDialog?.querySelector?.('[data-action="clear-activity-history"]');
  if (!clear) return;
  clear.disabled = !state.tours.length || deletionPending;
  accountDialog.querySelector('[data-action="manager-signout"]').disabled = deletionPending || signingOut;
}
window.addEventListener("hashchange", () => {
  if (state.session) {
    applyCategory();
    window.scrollTo({ top: 0, behavior: "instant" });
  }
});
initialize();

function applyCategory() {
  const key = location.hash.slice(1);
  const category = Object.hasOwn(categories, key) ? key : "overview";
  document.querySelector(".manager-navigation").hidden = !state.session;
  document.querySelector(".sidebar-account").hidden = !state.session;
  managerView.dataset.category = category;
  const title = document.getElementById("managerPageTitle");
  if (title) title.textContent = categories[category];
  for (const link of document.querySelectorAll(".manager-navigation a")) {
    const active = link.hash === `#${category}`;
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  for (const panel of managerView.querySelectorAll("[data-category-panel]")) {
    panel.hidden = category !== "overview" && panel.dataset.categoryPanel !== category;
  }
  const metrics = managerView.querySelector(".manager-metrics");
  if (metrics) metrics.hidden = category !== "overview";
}

function handleChange(event) {
  if (event.target.id === "reportPeriod") {
    state.periodFilter = event.target.value;
    renderDashboard();
    return;
  }
  const reportForm = event.target.closest?.("[data-client-report-form]");
  if (reportForm) captureClientReport(reportForm);
}

async function initialize() {
  managerView.innerHTML = renderLoading("Vérification de la session...");
  const sessionResult = await getManagerSession();

  if (!sessionResult.ok || !sessionResult.session) {
    renderLogin();
    return;
  }

  const authorization = await verifyManagerAccess();
  if (!authorization.ok || !authorization.authorized) {
    await signOutManager();
    state.error = "Ce compte n'est pas autorisé comme responsable.";
    renderLogin();
    return;
  }

  await activateManagerSession(sessionResult.session);
}

async function activateManagerSession(session) {
  state.session = session;
  const generation = ++sessionGeneration;
  await refreshDashboard();
  if (generation !== sessionGeneration || !state.session || signingOut) return;
  schedulePeriodRollover();
  await startLiveUpdates();
}

function stopDashboardUpdates() {
  stopLiveUpdates?.();
  stopLiveUpdates = null;
  window.clearTimeout(liveRefreshTimer);
  window.clearTimeout(periodRolloverTimer);
  liveRefreshTimer = null;
  periodRolloverTimer = null;
}

async function startLiveUpdates() {
  stopLiveUpdates?.();
  stopLiveUpdates = null;
  const generation = sessionGeneration;
  const stop = await subscribeManagerUpdates(() => {
    if (generation === sessionGeneration) scheduleLiveRefresh();
  });
  if (generation !== sessionGeneration || !state.session || signingOut) stop();
  else stopLiveUpdates = stop;
}

async function handleSubmit(event) {
  event.preventDefault();
  const form = event.target;

  if (form.id === "managerLoginForm") {
    await handleManagerLogin(form);
    return;
  }

  if (form.id === "createAgentForm") {
    await handleCreateAgent(form);
    return;
  }

  if (form.id === "createSiteForm") {
    await handleCreateSite(form);
    return;
  }

  if (form.matches("[data-checkpoint-form]")) {
    await handleCreateCheckpoint(form);
    return;
  }

  if (form.matches("[data-pin-form]")) {
    await handleResetPin(form);
    return;
  }

}

async function handleClick(event) {
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (!action) {
    return;
  }

  if (action === "select-report-type") {
    for (const form of managerView.querySelectorAll("[data-client-report-form]")) captureClientReport(form);
    state.reportType = event.target.closest("[data-report-type]").dataset.reportType === "incidents" ? "incidents" : "activity";
    renderDashboard();
    return;
  }

  if (action.startsWith("delete-")) {
    await handleDelete(event.target.closest("[data-action]"));
    return;
  }

  if (action === "clear-activity-history") {
    if (!state.tours.length || deletionPending) return;
    state.clearHistoryConfirmOpen = true;
    state.message = "";
    state.error = "";
    renderDashboard();
    return;
  }

  if (action === "cancel-clear-activity-history") {
    state.clearHistoryConfirmOpen = false;
    renderDashboard();
    return;
  }

  if (action === "confirm-clear-activity-history") {
    await handleClearActivityHistory();
    return;
  }

  if (action === "manager-signout") {
    if (signingOut) return;
    signingOut = true;
    ++sessionGeneration;
    stopDashboardUpdates();
    const result = await signOutManager().catch((error) => ({ ok: false, error }));
    signingOut = false;
    if (!result.ok) {
      state.error = "Impossible de se déconnecter. Vérifiez votre connexion et réessayez.";
      renderDashboard();
      schedulePeriodRollover();
      await startLiveUpdates();
      return;
    }
    state.session = null;
    state.agents = [];
    state.tours = [];
    state.sites = [];
    state.checkpoints = [];
    state.expandedAgentIds.clear();
    state.expandedSiteIds.clear();
    state.agentFormOpen = false;
    state.siteFormOpen = false;
    state.clearHistoryConfirmOpen = false;
    state.lastUpdated = null;
    state.clientReports = {
      activity: { siteId: "", from: "", to: "" },
      incidents: { siteId: "", from: "", to: "" }
    };
    state.message = "";
    state.error = "";
    renderLogin();
    return;
  }

  if (action === "refresh-dashboard") {
    await refreshDashboard(false);
    return;
  }

  if (action === "toggle-agent-form") {
    state.agentFormOpen = !state.agentFormOpen;
    state.error = "";
    renderDashboard();
    return;
  }

  if (action === "toggle-agent-panel") {
    captureExpandedPanels();
    const agentId = event.target.closest("[data-agent-panel-id]").dataset.agentPanelId;
    if (state.expandedAgentIds.has(agentId)) state.expandedAgentIds.delete(agentId);
    else state.expandedAgentIds.add(agentId);
    renderDashboard(false);
    return;
  }

  if (action === "toggle-site-form") {
    state.siteFormOpen = !state.siteFormOpen;
    state.error = "";
    renderDashboard();
    return;
  }

  if (action === "create-starting-post") {
    const button = event.target.closest("[data-site-id]");
    button.disabled = true;
    const result = await createManagedStartingPost(button.dataset.siteId);
    if (!result.ok) state.error = getManagerError(result.error);
    else { state.error = ""; state.message = "Poste A créé."; }
    await refreshDashboard(false);
    return;
  }

  if (action === "show-qr") {
    showQrCode(event.target.closest("[data-checkpoint-id]").dataset.checkpointId);
    return;
  }

  if (action === "export-site-qr-codes") {
    await exportSiteQrCodes(event.target.closest("[data-site-id]"));
    return;
  }

  if (action === "export-client-report") {
    await exportClientReport(event.target.closest("[data-action]"));
    return;
  }

  if (action === "set-tour-filter") {
    state.tourFilter = event.target.closest("[data-filter]").dataset.filter;
    renderDashboard();
    return;
  }

  if (action === "toggle-agent") {
    const button = event.target.closest("[data-agent-id]");
    button.disabled = true;
    const result = await setManagedAgentActive(button.dataset.agentId, button.dataset.active !== "true");
    if (!result.ok) {
      state.error = getManagerError(result.error);
      button.disabled = false;
      renderDashboard();
      return;
    }

    state.message = button.dataset.active === "true" ? "Agent désactivé" : "Agent activé";
    state.error = "";
    await refreshDashboard();
  }
}

async function handleClearActivityHistory() {
  if (deletionPending || !state.tours.length) return;
  deletionPending = true;
  state.clearHistoryConfirmOpen = false;
  state.message = "";
  state.error = "";
  renderDashboard();
  try {
    const result = await clearManagerActivityHistory();
    if (!result.ok) {
      state.error = getManagerError(result.error);
      return;
    }
    await refreshDashboard(false);
    if (!state.error && state.tours.length) {
      state.error = `Suppression incomplète : ${state.tours.length} activité${state.tours.length > 1 ? "s restent" : " reste"}. Actualisez puis réessayez.`;
    } else if (!state.error) {
      state.message = `${result.deletedCount} activité${result.deletedCount > 1 ? "s" : ""} supprimée${result.deletedCount > 1 ? "s" : ""}.`;
    }
  } catch (error) {
    state.error = getManagerError(error);
  } finally {
    deletionPending = false;
    renderDashboard();
  }
}

async function handleDelete(button) {
  if (deletionPending) return;
  const kind = button.dataset.action.slice(7);
  const collections = { agent: state.agents, site: state.sites, checkpoint: state.checkpoints };
  const item = collections[kind]?.find((entry) => entry.id === button.dataset.id);
  if (!item) return;
  const details = {
    agent: "Son accès sera supprimé. Ses tournées et scans enregistrés seront conservés.",
    site: "Tous les QR codes de ce site seront supprimés. L'historique sera conservé.",
    checkpoint: "Ce point sera retiré des prochaines tournées. Les scans enregistrés seront conservés."
  };
  if (kind === "checkpoint" && item.kind === "start") {
    details.checkpoint = "Le départ et la clôture seront indisponibles jusqu'à la création d'un nouveau Poste A. Les scans enregistrés seront conservés.";
  }
  if (!window.confirm(`Supprimer « ${item.name || item.label} » ?\n\n${details[kind]}\n\nVérifiez que les téléphones ont synchronisé leurs tournées. Cette action est définitive.`)) return;
  deletionPending = true;
  button.disabled = true;
  state.error = "";
  state.message = "";
  try {
    const result = await deleteManagedItem(kind, item.id);
    if (!result.ok) {
      state.error = getManagerError(result.error);
      renderDashboard();
      return;
    }
    await refreshDashboard(false);
    if (!state.error) {
      state.message = { agent: "Agent supprimé.", site: "Site et QR codes supprimés.", checkpoint: "QR code supprimé." }[kind];
      renderDashboard();
    }
  } catch {
    state.error = "La suppression n'a pas pu être confirmée. Actualisez avant de réessayer.";
    renderDashboard();
  } finally {
    deletionPending = false;
  }
}

async function handleManagerLogin(form) {
  const formData = new FormData(form);
  const submitButton = form.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  submitButton.textContent = "Connexion...";
  state.error = "";

  const result = await signInManager(formData.get("email"), formData.get("password"), {
    remember: formData.has("rememberManager")
  }).catch((error) => ({ ok: false, error }));
  if (!result.ok) {
    state.error = result.storageUnavailable
      ? "Cet appareil ne permet pas de mémoriser la connexion. Désactivez « Rester connecté » et réessayez."
      : result.unauthorized
      ? "Ce compte n'est pas autorisé comme responsable."
      : "Adresse e-mail ou mot de passe incorrect.";
    renderLogin();
    return;
  }

  await activateManagerSession(result.session);
}

async function handleCreateAgent(form) {
  const formData = new FormData(form);
  const pin = String(formData.get("pin") || "");
  if (!/^\d{6}$/.test(pin)) {
    state.error = "Le PIN doit contenir exactement 6 chiffres.";
    renderDashboard();
    return;
  }

  const submitButton = form.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  submitButton.textContent = "Création...";
  const result = await createManagedAgent({
    name: formData.get("name"),
    badge: formData.get("badge"),
    pin
  });

  if (!result.ok) {
    state.error = getManagerError(result.error);
    submitButton.disabled = false;
    submitButton.textContent = "Créer l'agent";
    renderDashboard();
    return;
  }

  state.message = "Agent créé. Vous pouvez lui transmettre son matricule et son PIN.";
  state.error = "";
  state.agentFormOpen = false;
  await refreshDashboard();
}

async function handleCreateSite(form) {
  const formData = new FormData(form);
  const result = await createManagedSite({ name: formData.get("name"), address: formData.get("address") });
  if (!result.ok) {
    state.error = getManagerError(result.error);
  } else {
    state.message = "Site créé avec son QR de départ.";
    state.error = "";
    state.siteFormOpen = false;
  }
  await refreshDashboard(false);
}

async function handleCreateCheckpoint(form) {
  const formData = new FormData(form);
  const result = await createManagedCheckpoint({ siteId: form.dataset.siteId, label: formData.get("label") });
  if (!result.ok) state.error = getManagerError(result.error);
  else {
    state.message = "Point de contrôle ajouté.";
    state.error = "";
    form.reset?.();
  }
  await refreshDashboard(false);
}

async function handleResetPin(form) {
  const formData = new FormData(form);
  const pin = String(formData.get("newPin") || "");
  if (!/^\d{6}$/.test(pin)) {
    state.error = "Le nouveau PIN doit contenir exactement 6 chiffres.";
    renderDashboard();
    return;
  }

  const submitButton = form.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  const result = await resetManagedAgentPin(form.dataset.agentId, pin);
  submitButton.disabled = false;
  if (!result.ok) {
    state.error = getManagerError(result.error);
    renderDashboard();
    return;
  }

  state.message = "PIN modifié.";
  state.error = "";
  form.reset?.();
  await refreshDashboard();
}

async function refreshDashboard(showLoading = true) {
  if (!state.session || signingOut) return;
  const generation = sessionGeneration;
  const request = ++refreshSequence;
  captureExpandedPanels();
  if (showLoading && !managerView.querySelector(".manager-toolbar")) {
    managerView.innerHTML = renderLoading("Lecture sécurisée des données...");
  }
  const [agentsResult, toursResult, sitesResult] = await Promise.all([
    fetchManagerAgents(),
    fetchManagerTours(),
    fetchManagerSites()
  ]);

  // A newer request or a logout invalidates every result from this request.
  if (generation !== sessionGeneration || request !== refreshSequence || !state.session || signingOut) return;

  if (!agentsResult.ok || !toursResult.ok || !sitesResult.ok) {
    state.error = getManagerError(agentsResult.error || toursResult.error || sitesResult.error);
    state.agents = [];
    state.tours = [];
    renderDashboard();
    return;
  }

  state.agents = agentsResult.agents;
  state.tours = normalizeRemoteTours(toursResult.tours);
  state.sites = sitesResult.sites;
  state.checkpoints = sitesResult.checkpoints;
  pruneExpandedPanels();
  state.lastUpdated = new Date();
  state.message = showLoading ? state.message : "Données actualisées.";
  state.error = "";
  renderDashboard();
}

function scheduleLiveRefresh() {
  if (!state.session || signingOut) return;
  const generation = sessionGeneration;
  window.clearTimeout(liveRefreshTimer);
  liveRefreshTimer = window.setTimeout(() => {
    if (generation === sessionGeneration && state.session && !signingOut && !deletionPending) refreshDashboard(false);
  }, 450);
}

function schedulePeriodRollover() {
  if (!state.session || signingOut) return;
  const generation = sessionGeneration;
  window.clearTimeout(periodRolloverTimer);
  const now = new Date();
  const nextMidnight = new Date(now);
  nextMidnight.setHours(24, 0, 1, 0);
  periodRolloverTimer = window.setTimeout(() => {
    if (generation !== sessionGeneration || !state.session || signingOut) return;
    renderDashboard();
    schedulePeriodRollover();
  }, nextMidnight.getTime() - now.getTime());
}

function renderLogin() {
  closeAccountDialog(true);
  document.querySelector(".manager-navigation").hidden = true;
  document.querySelector(".sidebar-account").hidden = true;
  scheduleBannerDismissal();
  managerView.innerHTML = `
    <section class="login-panel manager-login">
      <div class="login-title">
        <p class="eyebrow">Espace responsable</p>
        <h2>Connexion sécurisée</h2>
      </div>
      ${state.error ? `<p class="form-message error">${escapeHtml(state.error)}</p>` : ""}
      <form class="field-stack" id="managerLoginForm">
        <label>
          Adresse e-mail
          <input name="email" type="email" autocomplete="username" required>
        </label>
        <label>
          Mot de passe
          <input name="password" type="password" autocomplete="current-password" required>
        </label>
        <label class="remember-manager">
          <input name="rememberManager" type="checkbox" aria-describedby="rememberManagerHelp">
          <span class="remember-manager-copy">
            <span>Rester connecté</span>
            <small id="rememberManagerHelp">Sur cet appareil uniquement</small>
          </span>
          <span class="remember-manager-switch" aria-hidden="true"></span>
        </label>
        <button class="primary-button" type="submit">Se connecter</button>
      </form>
    </section>
  `;
}

function scheduleBannerDismissal() {
  for (const [key, style] of [["message", "success"], ["error", "error"]]) {
    const previous = bannerTimers.get(key);
    if (previous?.text === state[key]) continue;
    window.clearTimeout(previous?.timer);
    bannerTimers.delete(key);
    if (!state[key]) continue;
    const text = state[key];
    const timer = window.setTimeout(() => {
      if (state[key] === text) {
        state[key] = "";
        managerView.querySelector?.(`.form-message.${style}`)?.remove();
      }
      bannerTimers.delete(key);
    }, 5000);
    bannerTimers.set(key, { text, timer });
  }
}

function renderDashboard(capturePanels = true) {
  if (!state.session || signingOut) return;
  const forms = new Map();
  for (const form of managerView.querySelectorAll("form")) {
    const key = managerFormKey(form);
    if (key) forms.set(key, form);
  }
  const focused = document.activeElement;
  const selection = focused?.selectionStart == null ? null : [focused.selectionStart, focused.selectionEnd];
  scheduleBannerDismissal();
  if (capturePanels) captureExpandedPanels();
  const visibleTours = getVisibleTours();

  managerView.innerHTML = `
    <section class="manager-toolbar" aria-label="Session responsable">
      <div>
        <p class="eyebrow">Centre de contrôle</p>
        <h1 id="managerPageTitle">Vue d'ensemble</h1>
        <div class="manager-status-row">
          <span class="connection-state"><span></span> En ligne</span>
          <p class="manager-sync">${state.lastUpdated ? `Actualisé à ${formatClock(state.lastUpdated)}` : "Connexion sécurisée"}</p>
        </div>
      </div>
      <div class="manager-toolbar-actions">
        <button class="icon-text-button" type="button" data-action="refresh-dashboard">Actualiser</button>
      </div>
    </section>
    ${state.message ? `<p class="form-message success">${escapeHtml(state.message)}</p>` : ""}
    ${state.error ? `<p class="form-message error">${escapeHtml(state.error)}</p>` : ""}
    ${renderManagerMetrics()}
    ${renderSitesPanel()}
    <section class="manager-admin-panel" data-category-panel="agents">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Équipe</p>
          <h2>Agents autorisés <span class="manager-count">${state.agents.length}</span></h2>
        </div>
        <button class="primary-button manager-add-button" type="button" data-action="toggle-agent-form">${state.agentFormOpen ? "Fermer" : "Ajouter un agent"}</button>
      </div>
      ${state.agentFormOpen ? `<form class="manager-agent-form" id="createAgentForm">
        <label>
          Nom complet
          <input name="name" type="text" maxlength="80" placeholder="Ex. Jean Dupont" required>
        </label>
        <label>
          Matricule
          <input name="badge" type="text" maxlength="32" autocomplete="off" placeholder="Ex. AG-014" required>
        </label>
        <label>
          PIN initial
          <input name="pin" type="password" inputmode="numeric" pattern="[0-9]{6}" minlength="6" maxlength="6" autocomplete="new-password" placeholder="6 chiffres" required>
        </label>
        <button class="primary-button" type="submit">Créer l'agent</button>
      </form>` : ""}
      <div class="agent-admin-list">
        ${state.agents.length ? state.agents.map(renderAgentRow).join("") : renderNoAgents()}
      </div>
    </section>
    ${renderCategoryReportsPanel()}
    <section class="manager-tours-panel" data-category-panel="journal">
      <div class="section-heading manager-tours-heading">
        <div>
          <p class="eyebrow">Journal d'activité</p>
          <h2>Tournées récentes</h2>
        </div>
      </div>
      ${renderTourFilters()}
      <div class="manager-list">
        ${visibleTours.length ? visibleTours.map(renderTourCard).join("") : renderEmpty(state.tourFilter !== "all")}
      </div>
    </section>
    ${renderClearHistoryConfirmation()}
    <p class="manager-session-note">Connecté en tant que ${escapeHtml(state.session?.user?.email || "Responsable")}</p>
  `;
  // Reuse the actual form nodes: drafts, PINs and caret positions stay only in memory.
  for (const form of managerView.querySelectorAll("form")) {
    const previous = forms.get(managerFormKey(form));
    if (previous) form.replaceWith(previous);
  }
  applyCategory();
  updateAccountActions();
  if (focused?.isConnected && !focused.closest("[hidden]")) {
    focused.focus({ preventScroll: true });
    if (selection) focused.setSelectionRange(...selection);
  }
}

function managerFormKey(form) {
  if (form.id === "createAgentForm" || form.id === "createSiteForm") return form.id;
  if (form.hasAttribute?.("data-checkpoint-form")) return `checkpoint:${form.dataset.siteId}`;
  if (form.hasAttribute?.("data-pin-form")) return `pin:${form.dataset.agentId}`;
  return null;
}

function renderClearHistoryConfirmation() {
  if (!state.clearHistoryConfirmOpen) return "";
  const total = state.tours.length;
  return `
    <div class="manager-confirm-overlay" role="presentation">
      <section class="manager-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="clearHistoryTitle" aria-describedby="clearHistoryDescription">
        <p class="eyebrow">Action définitive</p>
        <h2 id="clearHistoryTitle">Effacer tout le journal ?</h2>
        <p id="clearHistoryDescription">${total} tournée${total > 1 ? "s" : ""}, tous les scans et tous les signalements seront supprimés. Les sessions agent seront fermées et leur historique local sera effacé.</p>
        <div class="manager-confirm-actions">
          <button class="secondary-button" type="button" data-action="cancel-clear-activity-history">Annuler</button>
          <button class="primary-button danger-button" type="button" data-action="confirm-clear-activity-history">Effacer définitivement</button>
        </div>
      </section>
    </div>
  `;
}

function renderAgentRow(agent) {
  const initials = agent.name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0))
    .join("")
    .toUpperCase();

  return `
    <article class="agent-admin-row ${agent.active ? "" : "inactive"}">
      <span class="agent-avatar" aria-hidden="true">${escapeHtml(initials || "AG")}</span>
      <div class="agent-admin-identity">
        <strong>${escapeHtml(agent.name)}</strong>
        <span>${escapeHtml(agent.badge)} · Tous les sites</span>
      </div>
      <span class="agent-state ${agent.active ? "active" : ""}">${agent.active ? "Actif" : "Désactivé"}</span>
      <button class="agent-manage-toggle" type="button" data-action="toggle-agent-panel" data-agent-panel-id="${escapeHtml(agent.id)}" aria-expanded="${state.expandedAgentIds.has(agent.id)}">Gérer</button>
      ${state.expandedAgentIds.has(agent.id) ? `
        <div class="agent-manage-actions">
          <button
            class="secondary-button"
            type="button"
            data-action="toggle-agent"
            data-agent-id="${escapeHtml(agent.id)}"
            data-active="${agent.active}"
          >${agent.active ? "Désactiver l'agent" : "Activer l'agent"}</button>
          <form class="agent-pin-form" data-pin-form data-agent-id="${escapeHtml(agent.id)}">
            <input name="newPin" type="password" inputmode="numeric" pattern="[0-9]{6}" minlength="6" maxlength="6" autocomplete="new-password" aria-label="Nouveau PIN pour ${escapeHtml(agent.name)}" placeholder="Nouveau PIN à 6 chiffres" required>
            <button class="secondary-button" type="submit">Changer le PIN</button>
          </form>
          <button class="icon-text-button delete-button" type="button" data-action="delete-agent" data-id="${escapeHtml(agent.id)}">Supprimer l'agent</button>
        </div>
      ` : ""}
    </article>
  `;
}

function renderSitesPanel() {
  return `
    <section class="manager-admin-panel sites-panel" data-category-panel="sites">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Configuration</p>
          <h2>Sites et QR codes</h2>
        </div>
        <button class="primary-button manager-add-button" type="button" data-action="toggle-site-form">${state.siteFormOpen ? "Fermer" : "Ajouter un site"}</button>
      </div>
      ${state.siteFormOpen ? `<form class="manager-agent-form site-create-form" id="createSiteForm">
        <label>Nom du site<input name="name" type="text" maxlength="100" placeholder="Ex. Hôtel Saint-Barth" required></label>
        <label>Adresse<input name="address" type="text" maxlength="180" placeholder="Adresse facultative"></label>
        <button class="primary-button" type="submit">Créer le site</button>
      </form>` : ""}
      <div class="site-list">
        ${state.sites.length ? state.sites.map(renderSiteRow).join("") : `<div class="empty-inline">Aucun site configuré.</div>`}
      </div>
    </section>
  `;
}

function renderCategoryReportsPanel() {
  return `
    <section class="manager-admin-panel category-reports-panel" data-category-panel="reports">
      <div class="section-heading">
        <div>
          <h2>Rapports clients</h2>
        </div>
      </div>
      <div class="manager-report-tabs" role="group" aria-label="Type de rapport">
        <button type="button" data-action="select-report-type" data-report-type="activity" aria-pressed="${state.reportType === "activity"}">Rapport d'activité</button>
        <button type="button" data-action="select-report-type" data-report-type="incidents" aria-pressed="${state.reportType === "incidents"}">Signalements</button>
      </div>
      ${state.sites.length ? `
        <div class="client-report-list">
          ${renderClientReportRow(state.reportType, state.reportType === "activity" ? "Rapport d'activité" : "Rapport de signalements", "")}
        </div>
      ` : `<div class="empty-inline">Ajoutez d'abord un site pour créer un rapport.</div>`}
    </section>
  `;
}

function renderClientReportRow(type, title, description) {
  const range = getClientReportState(type);
  return `
    <div class="client-report-row">
      <div class="client-report-copy">
        <h3>${escapeHtml(title)}</h3>
        <p>${escapeHtml(description)}</p>
      </div>
      <div class="client-report-controls" data-client-report-form data-report-type="${escapeHtml(type)}">
        <label>Site
          <select name="siteId">
            ${state.sites.map((site) => `<option value="${escapeHtml(site.id)}" ${site.id === range.siteId ? "selected" : ""}>${escapeHtml(site.name)}</option>`).join("")}
          </select>
        </label>
        <label>Du<input type="date" name="from" value="${range.from}" required></label>
        <label>Au<input type="date" name="to" value="${range.to}" required></label>
        <button class="secondary-button client-report-button" type="button" data-action="export-client-report" data-report-type="${escapeHtml(type)}">Télécharger le rapport PDF</button>
      </div>
    </div>
  `;
}

function renderSiteRow(site) {
  const points = state.checkpoints.filter((point) => point.site_id === site.id);
  return `
    <details class="site-row" data-site-panel-id="${escapeHtml(site.id)}"${state.expandedSiteIds.has(site.id) ? " open" : ""}>
      <summary>
        <div><strong>${escapeHtml(site.name)}</strong><span>${escapeHtml(site.address || "Adresse non renseignée")}</span></div>
        <span class="site-qr-count">${points.filter((point) => point.active).length} QR actifs</span>
        <span class="tour-chevron" aria-hidden="true"></span>
      </summary>
      <div class="site-details">
        <div class="checkpoint-list">${points.map((point) => renderCheckpointRow(point)).join("")}</div>
        ${points.some((point) => point.kind === "start") ? "" : `<div class="missing-start"><span>Poste A manquant</span><button class="secondary-button" type="button" data-action="create-starting-post" data-site-id="${escapeHtml(site.id)}">Ajouter Poste A</button></div>`}
        <form class="checkpoint-form" data-checkpoint-form data-site-id="${escapeHtml(site.id)}">
          <input name="label" type="text" maxlength="100" placeholder="Nom du nouveau point" required>
          <button class="secondary-button" type="submit">Ajouter un point</button>
        </form>
        <div class="site-actions">
          <button class="secondary-button site-qr-export-button" type="button" data-action="export-site-qr-codes" data-site-id="${escapeHtml(site.id)}">Exporter les QR</button>
          <button class="icon-text-button delete-button site-delete-button" type="button" data-action="delete-site" data-id="${escapeHtml(site.id)}">Supprimer le site</button>
        </div>
      </div>
    </details>
  `;
}

function captureExpandedPanels() {
  for (const form of managerView.querySelectorAll?.("[data-client-report-form]") || []) captureClientReport(form);
  const openSites = managerView.querySelectorAll?.("details.site-row[open][data-site-panel-id]") || [];
  const openAgents = managerView.querySelectorAll?.("[data-agent-panel-id][aria-expanded='true']") || [];
  for (const panel of openSites) state.expandedSiteIds.add(panel.dataset.sitePanelId);
  for (const panel of openAgents) state.expandedAgentIds.add(panel.dataset.agentPanelId);

  const closedSites = managerView.querySelectorAll?.("details.site-row:not([open])[data-site-panel-id]") || [];
  const closedAgents = managerView.querySelectorAll?.("[data-agent-panel-id][aria-expanded='false']") || [];
  for (const panel of closedSites) state.expandedSiteIds.delete(panel.dataset.sitePanelId);
  for (const panel of closedAgents) state.expandedAgentIds.delete(panel.dataset.agentPanelId);
}

function pruneExpandedPanels() {
  const siteIds = new Set(state.sites.map((site) => site.id));
  const agentIds = new Set(state.agents.map((agent) => agent.id));
  for (const id of state.expandedSiteIds) if (!siteIds.has(id)) state.expandedSiteIds.delete(id);
  for (const id of state.expandedAgentIds) if (!agentIds.has(id)) state.expandedAgentIds.delete(id);
}

function renderCheckpointRow(point) {
  return `
    <div class="checkpoint-admin-row ${point.active ? "" : "inactive"}">
      <div><strong>${escapeHtml(point.label)}</strong><span>${point.kind === "start" ? "Départ et clôture" : "Point de contrôle"}${point.active ? "" : " · Inactif"}</span></div>
      <button class="icon-text-button" type="button" data-action="show-qr" data-checkpoint-id="${escapeHtml(point.id)}">Afficher QR</button>
      <button class="icon-text-button delete-button" type="button" data-action="delete-checkpoint" data-id="${escapeHtml(point.id)}" aria-label="Supprimer le QR code ${escapeHtml(point.label)}">Supprimer</button>
    </div>
  `;
}

function renderNoAgents() {
  return `
    <div class="empty-inline">
      <strong>Aucun agent autorisé</strong>
      <span>Créez le premier accès agent avec un matricule et un PIN.</span>
    </div>
  `;
}

function renderLoading(message) {
  return `
    <section class="status-panel">
      <p class="eyebrow">Espace responsable</p>
      <h2 class="status-title">Chargement</h2>
      <p class="status-copy">${escapeHtml(message)}</p>
    </section>
  `;
}

function renderManagerMetrics() {
  const activeTours = state.tours.filter((tour) => tour.status === "active").length;
  const completedTours = state.tours.filter((tour) => tour.status === "completed").length;
  const incidentCount = state.tours.reduce((count, tour) => count + (tour.incidents?.length || 0), 0);
  const activeAgents = state.agents.filter((agent) => agent.active).length;

  return `
    <section class="manager-metrics" aria-label="Indicateurs">
      <div class="manager-metric blue"><span>Tournées en cours</span><strong>${activeTours}</strong></div>
      <div class="manager-metric green"><span>Tournées terminées</span><strong>${completedTours}</strong></div>
      <div class="manager-metric red"><span>Incidents signalés</span><strong>${incidentCount}</strong></div>
      <div class="manager-metric neutral"><span>Agents actifs</span><strong>${activeAgents}</strong></div>
    </section>
  `;
}

function renderTourFilters() {
  const filters = [
    ["all", "Toutes"],
    ["active", "En cours"],
    ["completed", "Terminées"],
    ["cancelled", "Annulées"]
  ];

  return `
    <div class="tour-filter-bar">
      <div class="tour-filters" role="group" aria-label="Filtrer les tournées">
        ${filters.map(([value, label]) => `
          <button class="tour-filter ${state.tourFilter === value ? "active" : ""}" type="button" data-action="set-tour-filter" data-filter="${value}">${label}</button>
        `).join("")}
      </div>
      <label class="period-filter">Période
        <select id="reportPeriod">
          <option value="1" ${state.periodFilter === "1" ? "selected" : ""}>Aujourd'hui</option>
          <option value="7" ${state.periodFilter === "7" ? "selected" : ""}>7 jours</option>
          <option value="30" ${state.periodFilter === "30" ? "selected" : ""}>30 jours</option>
          <option value="all" ${state.periodFilter === "all" ? "selected" : ""}>Tout</option>
        </select>
      </label>
    </div>
  `;
}

function renderTourCard(tour) {
  const hasIncidents = (tour.incidents || []).length > 0;
  const statusLabel = {
    active: "En cours",
    completed: "Terminée",
    cancelled: "Annulée"
  }[tour.status] || tour.status;
  const endTime = tour.completedAt || tour.cancelledAt;
  const scans = tour.scans || [];

  return `
    <details class="manager-tour-row">
      <summary>
        <div class="tour-main">
          <strong>${escapeHtml(tour.agentName || "Agent")}</strong>
          <span>${escapeHtml(tour.agentBadge || "Agent")} · ${formatTime(tour.startedAt)}${endTime ? ` - ${formatClock(new Date(endTime))}` : ""}</span>
        </div>
        <span class="tour-scan-count">${scans.length} scan${scans.length > 1 ? "s" : ""}</span>
        <span class="tour-status ${tour.status}${hasIncidents ? " has-incidents" : ""}">${statusLabel}</span>
        <span class="tour-chevron" aria-hidden="true"></span>
      </summary>
      <div class="tour-details">
        ${tour.siteName ? `<p class="tour-note"><strong>Site</strong>${escapeHtml(tour.siteName)}</p>` : ""}
        ${tour.cancelReason ? `<p class="tour-note"><strong>Motif</strong>${escapeHtml(tour.cancelReason)}</p>` : ""}
        ${tour.comment ? `<p class="tour-note"><strong>Commentaire</strong>${escapeHtml(tour.comment)}</p>` : ""}
        ${(tour.incidents || []).map(renderIncident).join("")}
        <div class="scan-log">
          ${scans.length ? scans.map(renderScanRow).join("") : `<p class="muted">Aucun scan enregistré.</p>`}
        </div>
      </div>
    </details>
  `;
}

function renderScanRow(scan) {
  return `
    <div class="scan-log-row">
      <div class="scan-log-details">
        <strong>${escapeHtml(scan.pointLabel)}</strong>
        ${renderScanLocation(scan.gps)}
      </div>
      <span>${formatTime(scan.scannedAt)}</span>
    </div>
  `;
}

function renderScanLocation(gps) {
  if (!Number.isFinite(gps?.lat) || !Number.isFinite(gps?.lng)) {
    return `<span class="scan-location unavailable">Position indisponible</span>`;
  }

  const accuracy = Number.isFinite(gps.accuracy) ? ` · ±${Math.round(gps.accuracy)} m` : "";
  const mapUrl = `https://www.google.com/maps?q=${encodeURIComponent(`${gps.lat},${gps.lng}`)}`;
  return `<a class="scan-location" href="${mapUrl}" target="_blank" rel="noopener">Voir la position${accuracy}</a>`;
}

function renderIncident(incident) {
  return `
    <article class="incident-entry ${incident.category === "Urgence" ? "urgent" : ""}">
      <div>
        <span class="incident-category">${escapeHtml(incident.category)}</span>
        <strong>${formatTime(incident.createdAt)}</strong>
      </div>
      ${incident.note ? `<p>${escapeHtml(incident.note)}</p>` : ""}
      ${incident.photoData ? `<img src="${escapeHtml(incident.photoData)}" alt="Photo du signalement" loading="lazy">` : ""}
      ${renderScanLocation(incident.gps)}
    </article>
  `;
}

function renderEmpty(filtered = false) {
  return `
    <div class="manager-empty">
      <p class="eyebrow">Aucune donnée</p>
      <h3>${filtered ? "Aucune tournée pour ce filtre" : "Pas encore de tournée"}</h3>
      <p class="muted">${filtered ? "Choisissez un autre état pour afficher les tournées." : "Les tournées apparaîtront ici après les premiers scans envoyés."}</p>
    </div>
  `;
}

function normalizeRemoteTours(rows) {
  return (rows || []).map((row) => ({
    id: row.id,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    cancelledAt: row.cancelled_at,
    cancelReason: row.cancel_reason,
    comment: row.comment || "",
    agentName: row.agent_name,
    agentBadge: row.agent_badge,
    siteId: row.site_id,
    siteName: row.sites?.name || row.site_name || "",
    incidents: (row.incidents || []).map((incident) => ({
      id: incident.id,
      category: incident.category,
      note: incident.note || "",
      photoData: incident.photo_data || "",
      createdAt: incident.created_at,
      gps: incident.gps_lat == null || incident.gps_lng == null ? null : {
        lat: Number(incident.gps_lat),
        lng: Number(incident.gps_lng),
        accuracy: incident.gps_accuracy == null ? null : Number(incident.gps_accuracy)
      }
    })),
    scans: (row.tour_scans || [])
      .map((scan) => ({
        id: scan.id,
        pointLabel: scan.point_label,
        type: scan.scan_type,
        scannedAt: scan.scanned_at,
        gps: scan.gps_lat == null || scan.gps_lng == null ? null : {
          lat: Number(scan.gps_lat),
          lng: Number(scan.gps_lng),
          accuracy: scan.gps_accuracy == null ? null : Number(scan.gps_accuracy)
        }
      }))
      .sort((a, b) => new Date(a.scannedAt) - new Date(b.scannedAt))
  }));
}

let qrOutputUrls = [];

function clearQrOutput() {
  qrOutputUrls.forEach((url) => URL.revokeObjectURL(url));
  qrOutputUrls = [];
}

function qrFileUrl(file) {
  const url = URL.createObjectURL(file);
  qrOutputUrls.push(url);
  return url;
}

function createQrImageUrl(point) {
  const qr = window.qrcode(0, "M");
  qr.addData(point.qr_payload);
  qr.make();
  const cellSize = 8;
  const margin = 32;
  const modules = qr.getModuleCount();
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = modules * cellSize + margin * 2;
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#000000";
  for (let row = 0; row < modules; row += 1) {
    for (let column = 0; column < modules; column += 1) {
      if (qr.isDark(row, column)) {
        context.fillRect(margin + column * cellSize, margin + row * cellSize, cellSize, cellSize);
      }
    }
  }
  return canvas.toDataURL("image/png");
}

async function exportSiteQrCodes(button) {
  const site = state.sites.find((item) => item.id === button?.dataset.siteId);
  const points = state.checkpoints.filter((point) => point.site_id === site?.id && point.active);
  const PdfDocument = window.jspdf?.jsPDF;
  if (!site || !points.length || typeof window.qrcode !== "function" || typeof PdfDocument !== "function") {
    state.error = "L'export des QR est indisponible. Actualisez la page puis réessayez.";
    renderDashboard();
    return;
  }

  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = "Préparation...";
  try {
    const doc = new PdfDocument({ unit: "mm", format: "a4", compress: true });
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    points.forEach((point, index) => {
      if (index) doc.addPage();
      const imageUrl = createQrImageUrl(point);
      doc.setFillColor(16, 19, 24);
      doc.rect(0, 0, pageWidth, 24, "F");
      doc.setFont("helvetica", "bold");
      doc.setFontSize(12);
      doc.setTextColor(255, 255, 255);
      doc.text("SAB SECURITY", 16, 10);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);
      doc.setTextColor(190, 202, 219);
      doc.text(site.name, 16, 16);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(20);
      doc.setTextColor(18, 24, 32);
      doc.text(doc.splitTextToSize(point.label, 170), pageWidth / 2, 48, { align: "center" });
      doc.addImage(imageUrl, "PNG", 45, 65, 120, 120);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(11);
      doc.setTextColor(59, 70, 86);
      doc.text(point.kind === "start" ? "Départ et clôture de la tournée" : "Point de contrôle", pageWidth / 2, 198, { align: "center" });
      doc.setFontSize(8);
      doc.setTextColor(116, 126, 140);
      doc.text(`${index + 1} / ${points.length}`, pageWidth / 2, pageHeight - 12, { align: "center" });
    });
    const filename = `${slugify(site.name) || "site"}-qr-codes.pdf`;
    const file = new File([doc.output("blob")], filename, { type: "application/pdf" });
    const mobile = window.matchMedia("(pointer: coarse)").matches;
    if (mobile && navigator.share && navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: `QR codes - ${site.name}` });
    } else {
      const link = document.createElement("a");
      link.href = qrFileUrl(file);
      link.download = filename;
      link.click();
    }
    state.message = `${points.length} QR code${points.length > 1 ? "s" : ""} exporté${points.length > 1 ? "s" : ""} pour ${site.name}.`;
  } catch (error) {
    if (error?.name !== "AbortError") {
      console.error("Site QR export failed:", error);
      state.error = "Les QR codes n'ont pas pu être exportés. Réessayez.";
    }
  } finally {
    button.disabled = false;
    button.textContent = originalLabel;
    renderDashboard();
  }
}

function configureQrAction(link, file, url) {
  link.href = url;
  link.onclick = async (event) => {
    const status = document.getElementById("qrOutputStatus");
    const fallback = document.getElementById("qrOutputFallback");
    status.hidden = true;
    fallback.hidden = true;
    const mobile = window.matchMedia("(pointer: coarse)").matches;
    // Files are prepared before the tap so Safari retains user activation.
    if (!mobile || !navigator.share || !navigator.canShare?.({ files: [file] })) return;
    event.preventDefault();
    if (link.getAttribute("aria-busy") === "true") return;
    link.setAttribute("aria-busy", "true");
    try {
      await navigator.share({ files: [file], title: document.getElementById("qrDialogTitle").textContent });
    } catch (error) {
      if (error.name !== "AbortError") {
        status.textContent = "Le partage est indisponible. Ouvrez le fichier pour l'enregistrer ou l'imprimer.";
        status.hidden = false;
        fallback.href = url;
        fallback.hidden = false;
      }
    } finally {
      link.removeAttribute("aria-busy");
    }
  };
}

function showQrCode(checkpointId) {
  const point = state.checkpoints.find((checkpoint) => checkpoint.id === checkpointId);
  if (!point || typeof window.qrcode !== "function") {
    state.error = "Générateur QR indisponible.";
    renderDashboard();
    return;
  }
  const site = state.sites.find((item) => item.id === point.site_id);
  const imageUrl = createQrImageUrl(point);
  clearQrOutput();
  const dialog = document.getElementById("qrDialog");
  dialog.onclose = clearQrOutput;
  document.getElementById("qrOutputStatus").hidden = true;
  document.getElementById("qrOutputFallback").hidden = true;
  document.getElementById("qrDialogSite").textContent = site?.name || "Site";
  document.getElementById("qrDialogTitle").textContent = point.label;
  const image = document.getElementById("qrDialogImage");
  image.src = imageUrl;
  image.alt = `QR code ${point.label}`;
  const download = document.getElementById("qrDownloadButton");
  const filename = `${slugify(site?.name || "site")}-${slugify(point.label)}`;
  const bytes = Uint8Array.from(atob(imageUrl.split(",")[1]), (character) => character.charCodeAt(0));
  const png = new File([bytes], `${filename}.png`, { type: "image/png" });
  download.download = png.name;
  configureQrAction(download, png, qrFileUrl(png));
  const print = document.getElementById("qrPrintButton");
  if (window.jspdf?.jsPDF) {
    const pdf = new window.jspdf.jsPDF();
    pdf.setFontSize(18);
    pdf.text(pdf.splitTextToSize(site?.name || "Site", 170), 105, 25, { align: "center" });
    pdf.setFontSize(14);
    const title = pdf.splitTextToSize(point.label, 170);
    pdf.text(title, 105, 50, { align: "center" });
    const qrTop = Math.max(65, 55 + title.length * 7);
    pdf.addImage(imageUrl, "PNG", 45, qrTop, 120, 120);
    pdf.setFontSize(11);
    pdf.text("Scanner avec l'application SAB S\u00e9curit\u00e9", 105, qrTop + 132, { align: "center" });
    const file = new File([pdf.output("blob")], `${filename}.pdf`, { type: "application/pdf" });
    configureQrAction(print, file, qrFileUrl(file));
  } else {
    print.removeAttribute("href");
    print.onclick = (event) => {
      event.preventDefault();
      const status = document.getElementById("qrOutputStatus");
      status.textContent = "Impression indisponible. Rechargez la page puis r\u00e9essayez.";
      status.hidden = false;
    };
  }
  dialog.showModal();
}

function getVisibleTours(now = new Date()) {
  const cutoff = getPeriodCutoff(state.periodFilter, now);
  return state.tours.filter((tour) => {
    const statusMatches = state.tourFilter === "all" || tour.status === state.tourFilter;
    const periodMatches = cutoff == null || new Date(tour.startedAt).getTime() >= cutoff;
    return statusMatches && periodMatches;
  });
}

function getClientReportState(type, now = new Date()) {
  const saved = state.clientReports[type] || {};
  const siteExists = state.sites.some((site) => site.id === saved.siteId);
  return {
    siteId: siteExists ? saved.siteId : (state.sites[0]?.id || ""),
    from: saved.from || formatFileDate(getPeriodCutoff("30", now)),
    to: saved.to || formatFileDate(now)
  };
}

function captureClientReport(form) {
  const type = form.dataset.reportType;
  if (!state.clientReports[type]) return;
  state.clientReports[type] = {
    siteId: form.querySelector('[name="siteId"]')?.value || "",
    from: form.querySelector('[name="from"]')?.value || "",
    to: form.querySelector('[name="to"]')?.value || ""
  };
}

function parseReportDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return formatFileDate(date) === value ? date : null;
}

async function exportClientReport(button) {
  const form = button?.closest("[data-client-report-form]");
  if (!form) return;
  captureClientReport(form);
  const type = form.dataset.reportType;
  const report = state.clientReports[type];
  const reportConfig = {
    activity: { label: "Rapport d'activité", file: "activite", incidentOnly: false },
    incidents: { label: "Rapport de signalements", file: "signalements", incidentOnly: true }
  }[type];
  if (!reportConfig) return;
  const { siteId } = report;
  const site = state.sites.find((item) => item.id === siteId);
  const from = parseReportDate(report.from);
  const to = parseReportDate(report.to);

  if (!from || !to || from > to) {
    state.error = "Choisissez une période valide : la date de début doit précéder la date de fin.";
    renderDashboard();
    return;
  }
  const PdfDocument = window.jspdf?.jsPDF;
  if (!site || typeof PdfDocument !== "function") {
    state.error = "Le générateur PDF est indisponible. Actualisez la page puis réessayez.";
    renderDashboard();
    return;
  }

  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = "Création...";
  state.error = "";

  try {
    const generatedAt = new Date();
    const endExclusive = new Date(to);
    endExclusive.setDate(endExclusive.getDate() + 1);
    const result = await fetchSiteReportTours(site.id, from.toISOString(), endExclusive.toISOString());
    if (!result.ok) throw result.error || new Error("Impossible de charger les tournées");
    const normalizedTours = normalizeRemoteTours(result.tours);
    const tours = (reportConfig.incidentOnly ? filterIncidentTours(normalizedTours) : normalizedTours)
      .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
    const doc = new PdfDocument({ unit: "mm", format: "a4", compress: true });
    buildSiteReportPdf(doc, site, tours, generatedAt, from, to, {
      reportLabel: reportConfig.label,
      incidentOnly: reportConfig.incidentOnly
    });
    doc.save(`${slugify(site.name) || "site"}-${reportConfig.file}-${formatFileDate(from)}_${formatFileDate(to)}.pdf`);
    state.message = `${reportConfig.label} créé pour ${site.name}.`;
  } catch (error) {
    console.error("Client PDF report generation failed:", error);
    state.error = "Le rapport PDF n'a pas pu être créé. Réessayez.";
  } finally {
    button.disabled = false;
    button.textContent = originalLabel;
    renderDashboard();
  }
}

function filterIncidentTours(tours) {
  return tours.filter((tour) => (tour.incidents || []).length > 0);
}

function buildSiteReportPdf(doc, site, tours, generatedAt, from, to, options = {}) {
  const margin = 16;
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const contentWidth = pageWidth - margin * 2;
  const bottomLimit = pageHeight - 18;
  let y = 0;

  const setText = (size = 10, color = [30, 38, 49], style = "normal") => {
    doc.setFont("helvetica", style);
    doc.setFontSize(size);
    doc.setTextColor(...color);
  };

  const addPageHeader = () => {
    doc.setFillColor(16, 19, 24);
    doc.rect(0, 0, pageWidth, 24, "F");
    setText(11, [255, 255, 255], "bold");
    doc.text("SAB SÉCURITÉ", margin, 10);
    setText(8, [190, 202, 219]);
    doc.text(options.reportLabel || "Rapport de tournées", margin, 16);
    y = 34;
  };

  const ensureSpace = (height) => {
    if (y + height <= bottomLimit) return;
    doc.addPage();
    addPageHeader();
  };

  const writeWrapped = (label, value) => {
    if (!value) return;
    const text = doc.splitTextToSize(`${label} : ${value}`, contentWidth - 8);
    ensureSpace(text.length * 4.5 + 3);
    setText(9, [59, 70, 86]);
    doc.text(text, margin + 4, y);
    y += text.length * 4.5 + 2;
  };

  const writeLocationLink = (gps, indent = 4) => {
    const mapUrl = getGoogleMapsUrl(gps);
    if (!mapUrl) {
      setText(8, [116, 126, 140]);
      doc.text("Position indisponible", margin + indent, y);
      y += 4.5;
      return;
    }
    const accuracy = Number.isFinite(gps.accuracy) ? ` (précision +/- ${Math.round(gps.accuracy)} m)` : "";
    setText(8, [42, 94, 184], "bold");
    doc.textWithLink(`Ouvrir dans Google Maps${accuracy}`, margin + indent, y, { url: mapUrl });
    y += 4.5;
  };

  addPageHeader();
  setText(20, [18, 24, 32], "bold");
  doc.text(site.name, margin, y);
  y += 8;
  if (site.address) {
    setText(9, [94, 105, 120]);
    const addressLines = doc.splitTextToSize(site.address, contentWidth);
    doc.text(addressLines, margin, y);
    y += addressLines.length * 4.5 + 2;
  }
  setText(9, [94, 105, 120]);
  doc.text(`Période : du ${formatPdfDate(from)} au ${formatPdfDate(to)}`, margin, y);
  y += 5;
  if (options.reportLabel) {
    doc.text(`Document : ${options.reportLabel}`, margin, y);
    y += 5;
  }
  doc.text(`Généré le ${formatPdfDateTime(generatedAt)}`, margin, y);
  y += 9;

  const incidents = tours.reduce((total, tour) => total + (tour.incidents?.length || 0), 0);
  const summary = options.incidentOnly
    ? [
      ["Signalements", incidents, [255, 98, 98]],
      ["Tournées concernées", tours.length, [79, 131, 255]],
      ["Agents concernés", new Set(tours.map((tour) => tour.agentBadge || tour.agentName)).size, [37, 194, 110]],
      ["Urgences", tours.reduce((total, tour) => total + (tour.incidents || []).filter((incident) => incident.category === "Urgence").length, 0), [255, 200, 87]]
    ]
    : [
      ["Tournées", tours.length, [79, 131, 255]],
      ["Terminées", tours.filter((tour) => tour.status === "completed").length, [37, 194, 110]],
      ["Annulées / en cours", tours.filter((tour) => tour.status !== "completed").length, [255, 200, 87]],
      ["Incidents", incidents, [255, 98, 98]]
    ];
  const cardGap = 3;
  const cardWidth = (contentWidth - cardGap * 3) / 4;
  summary.forEach(([label, value, color], index) => {
    const x = margin + index * (cardWidth + cardGap);
    doc.setFillColor(245, 247, 250);
    doc.roundedRect(x, y, cardWidth, 19, 1.5, 1.5, "F");
    doc.setFillColor(...color);
    doc.rect(x, y, 1.5, 19, "F");
    setText(7, [94, 105, 120], "bold");
    doc.text(label, x + 4, y + 6);
    setText(14, [18, 24, 32], "bold");
    doc.text(String(value), x + 4, y + 14);
  });
  y += 27;

  if (!tours.length) {
    setText(12, [18, 24, 32], "bold");
    doc.text("Aucune tournée enregistrée sur cette période.", margin, y);
  }

  tours.forEach((tour, index) => {
    ensureSpace(Math.min(estimateTourHeight(doc, tour, contentWidth), bottomLimit - 34));
    const hasIncidents = (tour.incidents || []).length > 0;
    const statusLabel = getTourStatusLabel(tour.status);
    doc.setDrawColor(hasIncidents ? 220 : 210, hasIncidents ? 72 : 217, hasIncidents ? 72 : 226);
    doc.setLineWidth(0.5);
    doc.line(margin, y, pageWidth - margin, y);
    y += 7;
    setText(12, [18, 24, 32], "bold");
    doc.text(`${index + 1}. ${tour.agentName || "Agent"}`, margin, y);
    setText(8, hasIncidents ? [194, 48, 48] : [59, 70, 86], "bold");
    doc.text(hasIncidents ? `${statusLabel} - INCIDENT` : statusLabel, pageWidth - margin, y, { align: "right" });
    y += 5;
    setText(9, [94, 105, 120]);
    doc.text(`Matricule ${tour.agentBadge || "-"} | ${formatPdfDateTime(tour.startedAt)}${getTourEndLabel(tour)}`, margin, y);
    y += 6;

    if (!options.incidentOnly) {
      writeWrapped("Commentaire", tour.comment);
      writeWrapped("Motif d'annulation", tour.cancelReason);
    }

    if (!options.incidentOnly && (tour.scans || []).length) {
      ensureSpace(9);
      setText(9, [18, 24, 32], "bold");
      doc.text("Scans", margin, y);
      y += 5;
      tour.scans.forEach((scan) => {
        ensureSpace(12);
        setText(9, [30, 38, 49], "bold");
        doc.text(scan.pointLabel || "Point de contrôle", margin + 4, y);
        setText(8, [94, 105, 120]);
        doc.text(formatPdfDateTime(scan.scannedAt), pageWidth - margin, y, { align: "right" });
        y += 4.5;
        writeLocationLink(scan.gps, 4);
      });
    }

    (tour.incidents || []).forEach((incident) => {
      const noteLines = incident.note ? doc.splitTextToSize(incident.note, contentWidth - 14) : [];
      const incidentHeight = 12 + noteLines.length * 4;
      ensureSpace(incidentHeight + 6);
      doc.setFillColor(255, 242, 242);
      doc.roundedRect(margin + 2, y - 3.5, contentWidth - 4, incidentHeight, 1.5, 1.5, "F");
      setText(9, [194, 48, 48], "bold");
      doc.text(`Incident : ${incident.category || "Signalé"}`, margin + 5, y);
      y += 4.5;
      if (noteLines.length) {
        setText(8, [59, 70, 86]);
        doc.text(noteLines, margin + 5, y);
        y += noteLines.length * 4;
      }
      writeLocationLink(incident.gps, 5);
      y += 2;
    });
    y += 6;
  });

  const pageCount = doc.getNumberOfPages();
  for (let page = 1; page <= pageCount; page += 1) {
    doc.setPage(page);
    setText(7, [116, 126, 140]);
    doc.text(`SAB Security | ${site.name}`, margin, pageHeight - 8);
    doc.text(`Page ${page} / ${pageCount}`, pageWidth - margin, pageHeight - 8, { align: "right" });
  }
}

function estimateTourHeight(doc, tour, contentWidth) {
  const commentLines = tour.comment ? doc.splitTextToSize(`Commentaire : ${tour.comment}`, contentWidth - 8).length : 0;
  const reasonLines = tour.cancelReason ? doc.splitTextToSize(`Motif d'annulation : ${tour.cancelReason}`, contentWidth - 8).length : 0;
  const scanHeight = (tour.scans || []).length ? 5 + (tour.scans.length * 9) : 0;
  const incidentHeight = (tour.incidents || []).reduce((height, incident) => {
    const noteLines = incident.note ? doc.splitTextToSize(incident.note, contentWidth - 14).length : 0;
    return height + 20 + noteLines * 4;
  }, 0);
  return 26 + (commentLines + reasonLines) * 4.5 + scanHeight + incidentHeight;
}

function getGoogleMapsUrl(gps) {
  if (!Number.isFinite(gps?.lat) || !Number.isFinite(gps?.lng)) return "";
  return `https://www.google.com/maps?q=${encodeURIComponent(`${gps.lat},${gps.lng}`)}`;
}

function getTourStatusLabel(status) {
  return { active: "En cours", completed: "Terminée", cancelled: "Annulée" }[status] || String(status || "-");
}

function getTourEndLabel(tour) {
  const endTime = tour.completedAt || tour.cancelledAt;
  return endTime ? ` - ${formatPdfDateTime(endTime)}` : "";
}

function formatPdfDate(value) {
  return new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(value));
}

function formatPdfDateTime(value) {
  return new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatFileDate(value) {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function getPeriodCutoff(period, now = new Date()) {
  if (period === "all") return null;
  const days = Number(period);
  if (!Number.isFinite(days) || days < 1) return null;
  const cutoff = new Date(now);
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - (days - 1));
  return cutoff.getTime();
}

function slugify(value) {
  return String(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function getManagerError(error) {
  const message = String(error?.message || "").toLowerCase();
  if (error?.code === "PGRST202" || message.includes("could not find the function")) {
    return "La suppression doit être activée dans Supabase. Exécutez la migration clear-activity-history.sql.";
  }
  if (error?.code === "21000") {
    return "La fonction de suppression Supabase doit être mise à jour. Exécutez la migration clear-activity-history.sql.";
  }
  if (message.includes("active patrol")) return "Terminez ou annulez les tournées en cours avant de supprimer cet élément.";
  if (message.includes("site has assigned agents")) return "Supprimez les agents affectés à ce site avant de le supprimer.";
  if (message.includes("starting post")) return "Le QR de départ est nécessaire. Il est supprimé uniquement avec son site.";
  if (message.includes("item not found")) return "Cet élément a déjà été supprimé. Actualisez la page.";
  if (message.includes("duplicate") || message.includes("unique")) {
    return "Ce matricule est déjà utilisé.";
  }
  if (message.includes("not authorized") || message.includes("permission")) {
    return "Action non autorisée.";
  }
  const code = String(error?.code || "").trim();
  return code ? `Une erreur est survenue (${code}). Réessayez.` : "Une erreur est survenue. Réessayez.";
}

function formatTime(isoValue) {
  if (!isoValue) {
    return "--:--";
  }

  return new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(isoValue));
}

function formatClock(date) {
  return new Intl.DateTimeFormat("fr-FR", {
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
