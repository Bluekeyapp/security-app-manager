import { getSupabaseClient } from "./supabaseClient.js?v=2";
import { managerSessionStorage } from "./managerSessionStorage.js?v=1";

export async function getManagerSession() {
  const supabase = await getSupabaseClient();
  if (!supabase) return { ok: false, session: null };

  const { data, error } = await supabase.auth.getSession();
  return error
    ? { ok: false, error, session: null }
    : { ok: true, session: data.session || null };
}

export async function signInManager(email, password, { remember = false } = {}) {
  const supabase = await getSupabaseClient();
  if (!supabase) return { ok: false, error: new Error("Supabase non configuré") };

  try {
    managerSessionStorage.setRemember(remember);
  } catch (error) {
    return { ok: false, storageUnavailable: true, error };
  }

  const { data, error } = await supabase.auth.signInWithPassword({
    email: String(email || "").trim(),
    password: String(password || "")
  }).catch((error) => ({ data: {}, error }));
  if (error) {
    managerSessionStorage.clear();
    return { ok: false, error };
  }

  const authorization = await verifyManagerAccess();
  if (!authorization.ok || !authorization.authorized) {
    await supabase.auth.signOut();
    managerSessionStorage.clear();
    return { ok: false, unauthorized: true, error: authorization.error };
  }

  return { ok: true, session: data.session };
}

export async function signOutManager() {
  const supabase = await getSupabaseClient();
  if (!supabase) {
    managerSessionStorage.clear();
    return { ok: true };
  }

  const { error } = await supabase.auth.signOut().catch((error) => ({ error }));
  if (!error) managerSessionStorage.clear();
  return error ? { ok: false, error } : { ok: true };
}

export async function verifyManagerAccess() {
  const supabase = await getSupabaseClient();
  if (!supabase) return { ok: false, authorized: false };

  const { data, error } = await supabase.rpc("is_current_user_manager");
  return error
    ? { ok: false, authorized: false, error }
    : { ok: true, authorized: data === true };
}

export async function fetchManagerAgents() {
  const supabase = await getSupabaseClient();
  if (!supabase) return { ok: false, agents: [] };

  const { data, error } = await supabase.from("agents")
    .select("id,name,badge,active,created_at")
    .order("name", { ascending: true });

  return error ? { ok: false, error, agents: [] } : { ok: true, agents: data || [] };
}

export async function createManagedAgent({ name, badge, pin }) {
  const supabase = await getSupabaseClient();
  if (!supabase) return { ok: false, error: new Error("Supabase non configuré") };

  const { data, error } = await supabase.rpc("manager_create_agent", {
    p_name: String(name || "").trim(),
    p_badge: String(badge || "").trim(),
    p_pin: String(pin || ""),
    p_site_id: null,
    p_all_sites_access: true
  });

  return error ? { ok: false, error } : { ok: true, agent: Array.isArray(data) ? data[0] : null };
}

export async function fetchManagerSites() {
  const supabase = await getSupabaseClient();
  if (!supabase) return { ok: false, sites: [], checkpoints: [] };

  const [sitesResult, checkpointsResult] = await Promise.all([
    supabase.from("sites").select("id,name,address,active,created_at").order("name"),
    supabase.from("checkpoints").select("id,site_id,label,kind,qr_payload,sort_order,active")
      .order("sort_order", { ascending: true })
  ]);
  const error = sitesResult.error || checkpointsResult.error;
  return error
    ? { ok: false, error, sites: [], checkpoints: [] }
    : { ok: true, sites: sitesResult.data || [], checkpoints: checkpointsResult.data || [] };
}

export async function createManagedSite({ name, address }) {
  const supabase = await getSupabaseClient();
  if (!supabase) return { ok: false, error: new Error("Supabase non configuré") };
  const { data, error } = await supabase.rpc("manager_create_site", {
    p_name: String(name || "").trim(),
    p_address: String(address || "").trim()
  });
  return error ? { ok: false, error } : { ok: true, site: Array.isArray(data) ? data[0] : null };
}

export async function createManagedCheckpoint({ siteId, label }) {
  const supabase = await getSupabaseClient();
  if (!supabase) return { ok: false, error: new Error("Supabase non configuré") };
  const { data, error } = await supabase.rpc("manager_create_checkpoint", {
    p_site_id: siteId,
    p_label: String(label || "").trim()
  });
  return error ? { ok: false, error } : { ok: true, checkpoint: Array.isArray(data) ? data[0] : null };
}

export async function createManagedStartingPost(siteId) {
  const supabase = await getSupabaseClient();
  if (!supabase) return { ok: false, error: new Error("Supabase non configuré") };
  const { error } = await supabase.rpc("manager_create_starting_post", { p_site_id: siteId });
  return error ? { ok: false, error } : { ok: true };
}

export async function deleteManagedItem(kind, id) {
  const operations = {
    agent: ["manager_delete_agent", "p_agent_id"],
    site: ["manager_delete_site", "p_site_id"],
    checkpoint: ["manager_delete_checkpoint", "p_checkpoint_id"]
  };
  const operation = operations[kind];
  if (!operation) return { ok: false, error: new Error("Invalid deletion type") };

  const supabase = await getSupabaseClient();
  if (!supabase) return { ok: false, error: new Error("Supabase non configuré") };
  const { data, error } = await supabase.rpc(operation[0], { [operation[1]]: id });
  return error ? { ok: false, error } : data === true
    ? { ok: true }
    : { ok: false, error: new Error("Item not found") };
}

export async function clearManagerActivityHistory() {
  const supabase = await getSupabaseClient();
  if (!supabase) return { ok: false, error: new Error("Supabase non configuré") };

  const { data, error } = await supabase.rpc("manager_purge_activity_history_v2");
  if (error) return { ok: false, error };
  if (!data?.ok) return { ok: false, error: new Error("Invalid purge response") };
  return { ok: true, deletedCount: Number(data.deleted_count || 0) };
}

export async function subscribeManagerUpdates(onUpdate) {
  const supabase = await getSupabaseClient();
  if (!supabase) return () => {};

  const channel = supabase.channel("manager-live-operations");
  ["tours", "tour_scans", "incidents", "agents", "sites", "checkpoints"].forEach((table) => {
    channel.on("postgres_changes", { event: "*", schema: "public", table }, onUpdate);
  });
  channel.subscribe();
  return () => supabase.removeChannel(channel);
}

export async function setManagedAgentActive(agentId, active) {
  const supabase = await getSupabaseClient();
  if (!supabase) return { ok: false, error: new Error("Supabase non configuré") };

  const { error } = await supabase.rpc("manager_set_agent_active", {
    p_agent_id: agentId,
    p_active: Boolean(active)
  });
  return error ? { ok: false, error } : { ok: true };
}

export async function resetManagedAgentPin(agentId, pin) {
  const supabase = await getSupabaseClient();
  if (!supabase) return { ok: false, error: new Error("Supabase non configuré") };

  const { error } = await supabase.rpc("manager_reset_agent_pin", {
    p_agent_id: agentId,
    p_pin: String(pin || "")
  });
  return error ? { ok: false, error } : { ok: true };
}

export async function fetchManagerTours() {
  const supabase = await getSupabaseClient();
  if (!supabase) return { ok: false, skipped: true, tours: [] };

  const { data, error } = await selectTours(supabase).limit(1000);
  return error ? { ok: false, error, tours: [] } : { ok: true, tours: data || [] };
}

export async function fetchSiteReportTours(siteId, from, to) {
  const supabase = await getSupabaseClient();
  if (!supabase) return { ok: false, error: new Error("Supabase non configuré") };

  const tours = [];
  const pageSize = 500;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await selectTours(supabase)
      .eq("site_id", siteId)
      .gte("started_at", from)
      .lt("started_at", to)
      .range(offset, offset + pageSize - 1);
    if (error) return { ok: false, error };
    tours.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }
  return { ok: true, tours };
}

function selectTours(supabase) {
  return supabase
    .from("tours")
    .select(`
      *,
      sites (name),
      tour_scans (
        id,
        point_label,
        scan_type,
        scanned_at,
        gps_lat,
        gps_lng,
        gps_accuracy
      ),
      incidents (
        id,
        category,
        note,
        photo_data,
        gps_lat,
        gps_lng,
        gps_accuracy,
        created_at
      )
    `)
    .order("started_at", { ascending: false });
}
