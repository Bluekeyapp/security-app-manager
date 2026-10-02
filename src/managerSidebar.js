// Adaptation of the supplied Sidebar primitive to the manager's native DOM.
const shell = document.querySelector(".manager-shell");
const navigation = document.getElementById("managerNavigation");
const toggle = document.querySelector(".sidebar-toggle");
const brand = document.querySelector(".sidebar-brand");
const mobile = window.matchMedia("(max-width: 700px)");
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const preferenceKey = "sab-manager-sidebar-collapsed";
let collapsed = false;
try { collapsed = localStorage.getItem(preferenceKey) === "true"; } catch { /* Storage can be disabled. */ }

const iconPaths = {
  overview: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  sites: '<path d="M3 21h18M5 21V5l7-2v18m0-14h7v14M8 7v1m0 3v1m0 3v1m7-6h1m-1 4h1m-1 4h1"/>',
  agents: '<circle cx="9" cy="8" r="3"/><path d="M3 21v-2a6 6 0 0 1 12 0v2m1-16a3 3 0 0 1 0 6m3 10v-2a6 6 0 0 0-3-5"/>',
  reports: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Zm0 0v6h6M8 13h8m-8 4h5"/>',
  journal: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'
};
for (const link of navigation.querySelectorAll("a")) {
  const key = link.getAttribute("href").split("#").pop();
  link.insertAdjacentHTML("afterbegin", `<svg class="sidebar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPaths[key] || ""}</svg>`);
}

const pill = document.createElement("span");
pill.className = "sidebar-active-pill";
pill.setAttribute("aria-hidden", "true");
navigation.prepend(pill);

function updatePill() {
  const active = navigation.querySelector("a.active");
  pill.hidden = navigation.hidden || !active;
  if (pill.hidden) return;
  pill.style.width = `${active.offsetWidth}px`;
  pill.style.height = `${active.offsetHeight}px`;
  pill.style.transform = `translate(${active.offsetLeft}px, ${active.offsetTop}px)`;
}

function applyCollapsed() {
  const effectiveCollapsed = collapsed && !mobile.matches;
  shell.dataset.sidebarCollapsed = String(effectiveCollapsed);
  toggle.setAttribute("aria-expanded", String(!effectiveCollapsed));
  toggle.setAttribute("aria-label", effectiveCollapsed ? "Déplier le menu" : "Replier le menu");
  brand.disabled = !effectiveCollapsed;
  for (const link of navigation.querySelectorAll("a")) {
    if (effectiveCollapsed) link.title = link.getAttribute("aria-label");
    else link.removeAttribute("title");
  }
  requestAnimationFrame(updatePill);
}

function toggleCollapsed() {
  collapsed = !collapsed;
  try { localStorage.setItem(preferenceKey, String(collapsed)); } catch { /* Keep working without persistence. */ }
  applyCollapsed();
}
toggle.addEventListener("click", toggleCollapsed);
brand.addEventListener("click", () => { if (collapsed && !mobile.matches) toggleCollapsed(); });
mobile.addEventListener("change", applyCollapsed);
new MutationObserver((records) => {
  if (records.some((record) => record.target !== pill)) updatePill();
}).observe(navigation, { attributes: true, subtree: true, attributeFilter: ["class", "hidden"] });
new ResizeObserver(updatePill).observe(navigation);

let scrollTimer;
navigation.addEventListener("scroll", () => {
  navigation.classList.add("is-scrolling");
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => navigation.classList.remove("is-scrolling"), 700);
}, { passive: true });
navigation.addEventListener("click", (event) => {
  const link = event.target.closest("a");
  if (link && mobile.matches) link.scrollIntoView({ block: "nearest", inline: "nearest", behavior: reducedMotion.matches ? "instant" : "smooth" });
});
applyCollapsed();
