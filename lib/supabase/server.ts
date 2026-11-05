import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { supabaseEnv } from "./env";

/**
 * Per-request client acting AS the signed-in user, so every query runs under
 * their RLS policies. There is deliberately no service-role client in the app.
 */
export async function createClient() {
  const store = await cookies();
  const { url, anonKey } = supabaseEnv();
  return createServerClient(url, anonKey, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          for (const { name, value, options } of list) store.set(name, value, options);
        } catch {
          // Server Component render: middleware refreshes the session instead.
        }
      },
    },
  });
}
