export const SUPABASE_CONFIG = {
  url: "https://wpfcrojohgwluuvouxyy.supabase.co",
  anonKey: "sb_publishable_sBGygt5DhZcB7FNa0RsARw_q3VI_5e9"
};

export function isSupabaseConfigured() {
  return Boolean(SUPABASE_CONFIG.url && SUPABASE_CONFIG.anonKey);
}
