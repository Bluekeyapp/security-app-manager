import { SUPABASE_CONFIG, isSupabaseConfigured } from "./config.js";

let clientPromise = null;

export async function getSupabaseClient() {
  if (!isSupabaseConfigured()) {
    return null;
  }

  if (!clientPromise) {
    clientPromise = import("https://esm.sh/@supabase/supabase-js@2").then(({ createClient }) =>
      createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey)
    );
  }

  return clientPromise;
}
