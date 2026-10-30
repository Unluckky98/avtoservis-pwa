// Supabase Edge Function (Deno). Deploy: supabase functions deploy assistant
// Secrets (supabase secrets set …): LLM_BASE_URL, LLM_API_KEY, LLM_MODEL, optional LLM_TOOL_MODE=json.
// SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are provided by the platform.
import { createClient } from '@supabase/supabase-js';
import { DEFAULT_LIMITS, handleAssistant, requestSchema } from '../_shared/ai/handler.ts';
import { openAiClient } from '../_shared/ai/openai-client.ts';
import { AssistantError, type Mode } from '../_shared/ai/types.ts';
import type { Providers, StudioInfo } from '../_shared/ai/tools.ts';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
  'access-control-allow-methods': 'POST, OPTIONS',
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json' } });

const HTTP: Record<AssistantError['code'], number> = { bad_request: 400, rate_limited: 429, budget: 429, unauthorized: 401, unavailable: 503 };

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  try {
    const body = await req.json().catch(() => null);
    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) throw new AssistantError('bad_request', 'Некорректный запрос.');
    const { slug, mode } = parsed.data as { slug: string; mode: Mode };

    const url = Deno.env.get('SUPABASE_URL')!;
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const service = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
    const base = Deno.env.get('LLM_BASE_URL');
    const key = Deno.env.get('LLM_API_KEY');
    const model = Deno.env.get('LLM_MODEL');
    if (!base || !key || !model) throw new AssistantError('unavailable', 'Помощник не настроен.');

    // Owner mode runs every data call under the caller's own JWT: the database, not this function, decides what they may read.
    const auth = req.headers.get('authorization') ?? '';
    const caller = createClient(url, anonKey, { auth: { persistSession: false }, global: { headers: auth ? { Authorization: auth } : {} } });
    let subject = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
    if (mode === 'owner') {
      const { data: u, error } = await caller.auth.getUser(auth.replace(/^Bearer /, ''));
      if (error || !u.user) throw new AssistantError('unauthorized', 'Войдите в кабинет.');
      subject = u.user.id;
      const ctx = await caller.rpc('owner_context', { p_slug: slug });
      if (ctx.error) throw new AssistantError('unauthorized', 'Нет доступа к этой студии.');
    }

    const pub = await caller.rpc('studio_public', { p_slug: slug });
    if (pub.error || !pub.data?.ok) throw new AssistantError('bad_request', 'Студия не найдена.');
    const studio = pub.data.studio as StudioInfo;
    const { data: tenantRow } = await service.from('tenants').select('id').eq('slug', slug).single();
    if (!tenantRow) throw new AssistantError('bad_request', 'Студия не найдена.');

    const providers: Providers = {
      timezone: studio.timezone,
      studio: async () => studio,
      availability: async (serviceId, from, to) => {
        const r = await caller.rpc('availability', { p_slug: slug, p_service_id: serviceId, p_from: from, p_to: to });
        if (r.error || !r.data?.ok) throw new Error(r.data?.code ?? 'availability_failed');
        return r.data.slots;
      },
      stats: async (from, to) => {
        const r = await caller.rpc('owner_stats', { p_slug: slug, p_from: from, p_to: to });
        if (r.error || !r.data?.ok) throw new Error(r.data?.code ?? 'stats_failed');
        return r.data;
      },
      bookings: async (fromIso, toIso) => {
        const r = await caller.rpc('owner_bookings', { p_slug: slug, p_from: fromIso, p_to: toIso, p_include_cancelled: false });
        if (r.error || !r.data?.ok) throw new Error(r.data?.code ?? 'bookings_failed');
        return r.data.bookings;
      },
    };

    const reply = await handleAssistant(body, mode, {
      llm: openAiClient({ baseURL: base, apiKey: key, model }),
      toolMode: Deno.env.get('LLM_TOOL_MODE') === 'json' ? 'json' : 'native',
      limits: DEFAULT_LIMITS,
      rateHit: async (bucket, limit, win) => (await service.rpc('rate_hit', { p_bucket: bucket, p_limit: limit, p_window_seconds: win })).data === true,
      reserveBudget: async (calls, tokens) => (await service.rpc('llm_reserve', { p_tenant: tenantRow.id, p_call_limit: calls, p_token_limit: tokens })).data === true,
      addTokens: async (n) => void (await service.rpc('llm_add_tokens', { p_tenant: tenantRow.id, p_tokens: n })),
      providers,
      studio: { name: studio.name, timezone: studio.timezone },
      subject,
    });
    return json(200, reply);
  } catch (e) {
    if (e instanceof AssistantError) return json(HTTP[e.code], { error: e.code, message: e.message });
    console.error('assistant failed', e instanceof Error ? e.message : e);
    return json(500, { error: 'internal', message: 'Помощник сейчас недоступен. Запись работает как обычно.' });
  }
});
