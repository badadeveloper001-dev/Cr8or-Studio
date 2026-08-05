import { createClient } from "@supabase/supabase-js";
import { getSecret } from "@/lib/security/secrets";

export function getSupabaseClient() {
  const supabaseUrl = getSecret("NEXT_PUBLIC_SUPABASE_URL");
  const supabaseAnonKey = getSecret("NEXT_PUBLIC_SUPABASE_ANON_KEY");

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error("Supabase environment variables are not configured.");
  }

  return createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      persistSession: false,
    },
  });
}
