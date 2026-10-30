import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

export type Turn = { role: 'user' | 'assistant'; content: string };

const reply = z.object({ answer: z.string(), path: z.string().optional(), tools_used: z.array(z.string()).optional() });

export class AssistantUnavailable extends Error {}

/** Calls the `assistant` Edge Function. Booking never depends on this: every failure is a friendly message. */
export async function askAssistant(client: SupabaseClient, slug: string, mode: 'client' | 'owner', history: Turn[]): Promise<string> {
  const { data, error } = await client.functions.invoke('assistant', { body: { slug, mode, messages: history.slice(-12) } });
  if (error) {
    let msg = 'Помощник сейчас недоступен. Запись работает как обычно.';
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.json === 'function') {
      const j = (await ctx.json().catch(() => null)) as { message?: string } | null;
      if (j?.message) msg = j.message;
    }
    throw new AssistantUnavailable(msg);
  }
  const r = reply.safeParse(data);
  if (!r.success) throw new AssistantUnavailable('Помощник вернул неожиданный ответ.');
  return r.data.answer;
}
