import { SUPABASE_CONFIG } from "./config.js";

export const MANAGER_AUTH_KEY = `sb-${new URL(SUPABASE_CONFIG.url).hostname.split(".")[0]}-auth-token`;
export const REMEMBER_MANAGER_KEY = "sab-manager-remember";

// Supabase refreshes its own tokens; only the user's persistence choice changes.
export function createManagerSessionStorage({
  local = () => globalThis.localStorage,
  session = () => globalThis.sessionStorage
} = {}) {
  const memory = new Map();
  const read = (area, key) => { try { return area()?.getItem(key) ?? null; } catch { return null; } };
  const remove = (area, key) => { try { area()?.removeItem(key); } catch { /* Storage may be unavailable. */ } };
  let remember = read(local, REMEMBER_MANAGER_KEY) === "true";

  return {
    setRemember(value) {
      // Fail visibly if a persistent session cannot be saved on this device.
      if (value) local().setItem(REMEMBER_MANAGER_KEY, "true");
      else remove(local, REMEMBER_MANAGER_KEY);
      remember = Boolean(value);
      this.removeItem(MANAGER_AUTH_KEY);
    },
    getItem(key) {
      return read(remember ? local : session, key) ?? memory.get(key) ?? null;
    },
    setItem(key, value) {
      if (remember) {
        local().setItem(key, value);
      } else {
        try { session().setItem(key, value); } catch { memory.set(key, value); }
      }
      remove(remember ? session : local, key);
    },
    removeItem(key) {
      remove(local, key);
      remove(session, key);
      memory.delete(key);
    },
    clear() {
      this.removeItem(MANAGER_AUTH_KEY);
      this.removeItem(`${MANAGER_AUTH_KEY}-user`);
      this.removeItem(`${MANAGER_AUTH_KEY}-code-verifier`);
      remove(local, REMEMBER_MANAGER_KEY);
      remember = false;
    }
  };
}

export const managerSessionStorage = createManagerSessionStorage();
