import { SUPABASE_CONFIG, isSupabaseConfigured } from "./config.js";
import { MANAGER_AUTH_KEY, managerSessionStorage } from "./managerSessionStorage.js?v=1";

let clientPromise = null;

export async function getSupabaseClient() {
  if (!isSupabaseConfigured()) {
    return null;
  }

  if (!clientPromise) {
    clientPromise = import("https://esm.sh/@supabase/supabase-js@2.117.2")
      .then(({ createClient }) => createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey, {
        auth: {
          storageKey: MANAGER_AUTH_KEY,
          storage: managerSessionStorage,
          persistSession: true,
          autoRefreshToken: true
        }
      }))
      .catch(() => {
        clientPromise = null;
        return null;
      });
  }

  return clientPromise;
}
