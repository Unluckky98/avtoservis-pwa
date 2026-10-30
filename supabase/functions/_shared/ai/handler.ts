import { z } from 'zod';
import { runJsonIntent, runNative, type LoopResult } from './loop.ts';
import { systemPrompt } from './prompts.ts';
import { toolsFor, type Providers } from './tools.ts';
import { AssistantError, type ChatMessage, type LlmClient, type Mode } from './types.ts';

export class ToolsUnsupportedError extends Error {}

export const requestSchema = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/),
  mode: z.enum(['client', 'owner']),
  messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().min(1).max(1000) })).min(1).max(12),
});
export type AssistantRequest = z.infer<typeof requestSchema>;

export type Limits = { callsPerDay: number; tokensPerDay: number; clientPer10Min: number; ownerPer10Min: number };
export const DEFAULT_LIMITS: Limits = { callsPerDay: 300, tokensPerDay: 400_000, clientPer10Min: 15, ownerPer10Min: 60 };

export type Deps = {
  llm: LlmClient;
  /** 'json' forces the JSON-intent path (provider without tool calling). */
  toolMode: 'native' | 'json';
  limits: Limits;
  /** Shared, atomic, database-backed counters (public.rate_hit / public.llm_reserve / public.llm_add_tokens). */
  rateHit(bucket: string, limit: number, windowSeconds: number): Promise<boolean>;
  reserveBudget(callLimit: number, tokenLimit: number): Promise<boolean>;
  addTokens(n: number): Promise<void>;
  providers: Providers;
  studio: { name: string; timezone: string };
  /** Who is asking, for rate-limiting: the user id for owners, the IP for clients. */
  subject: string;
  now?: Date;
};

export type AssistantReply = { answer: string; path: LoopResult['path']; tools_used: string[] };

export async function handleAssistant(raw: unknown, mode: Mode, d: Deps): Promise<AssistantReply> {
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success || parsed.data.mode !== mode) throw new AssistantError('bad_request', 'Некорректный запрос.');
  const req = parsed.data;
  if (req.messages[req.messages.length - 1]!.role !== 'user') throw new AssistantError('bad_request', 'Последнее сообщение должно быть от пользователя.');

  const perWindow = mode === 'client' ? d.limits.clientPer10Min : d.limits.ownerPer10Min;
  if (!(await d.rateHit(`assistant:${mode}:${req.slug}:${d.subject}`, perWindow, 600))) throw new AssistantError('rate_limited', 'Слишком много вопросов. Подождите немного.');
  if (!(await d.reserveBudget(d.limits.callsPerDay, d.limits.tokensPerDay))) throw new AssistantError('budget', 'На сегодня лимит помощника исчерпан. Запись работает как обычно.');

  const tools = toolsFor(mode, d.providers);
  const system = systemPrompt(mode, d.studio, d.now);
  const history: ChatMessage[] = req.messages.map((m) => ({ role: m.role, content: m.content }) as ChatMessage);

  let result: LoopResult;
  try {
    if (d.toolMode === 'json') result = await runJsonIntent(d.llm, system, history, tools);
    else {
      try {
        result = await runNative(d.llm, system, history, tools);
      } catch (e) {
        if (!(e instanceof ToolsUnsupportedError)) throw e;
        result = await runJsonIntent(d.llm, system, history, tools);
      }
    }
  } catch (e) {
    if (e instanceof AssistantError) throw e;
    throw new AssistantError('unavailable', 'Помощник сейчас недоступен. Запись работает как обычно.');
  }
  await d.addTokens(result.tokens).catch(() => {});
  const answer = result.answer || 'Не получилось сформулировать ответ. Попробуйте переформулировать вопрос.';
  return { answer: answer.slice(0, 2000), path: result.path, tools_used: result.toolsUsed };
}
