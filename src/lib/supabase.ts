import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;

export class ConfigError extends Error {}

/** One client per page. Clients (anon) never persist a session; the owner cabinet uses `ownerClient`. */
export function supabase(): SupabaseClient {
  const url = import.meta.env.VITE_SUPABASE_URL;
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !key) throw new ConfigError('Не заданы VITE_SUPABASE_URL и VITE_SUPABASE_ANON_KEY (см. SETUP.md).');
  client ??= createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  return client;
}

let owner: SupabaseClient | null = null;
/** Separate client with a persisted session, scoped storage key per studio. */
export function ownerClient(slug: string): SupabaseClient {
  const url = import.meta.env.VITE_SUPABASE_URL;
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !key) throw new ConfigError('Не заданы VITE_SUPABASE_URL и VITE_SUPABASE_ANON_KEY (см. SETUP.md).');
  owner ??= createClient(url, key, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: `avto-owner:${slug}` },
  });
  return owner;
}
