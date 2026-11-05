import "server-only";
import { createClient } from "@supabase/supabase-js";
import { supabaseEnv } from "./env";

/**
 * Service-role client. Used ONLY by the payment webhook (after signature
 * verification) to call apply_billing_event. Never import it anywhere else.
 */
export function createServiceClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  return createClient(supabaseEnv().url, key, { auth: { persistSession: false } });
}
