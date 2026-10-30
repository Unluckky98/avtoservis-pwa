import OpenAI from 'openai';
import { ToolsUnsupportedError } from './handler.ts';
import type { ChatMessage, LlmClient, LlmRequest, LlmResponse } from './types.ts';

/** Adapter for any OpenAI-compatible endpoint: LLM_BASE_URL, LLM_API_KEY, LLM_MODEL. */
export function openAiClient(cfg: { baseURL: string; apiKey: string; model: string }): LlmClient {
  const sdk = new OpenAI({ baseURL: cfg.baseURL, apiKey: cfg.apiKey, timeout: 25_000, maxRetries: 1 });
  return {
    async chat(req: LlmRequest): Promise<LlmResponse> {
      try {
        const r = await sdk.chat.completions.create({
          model: cfg.model,
          temperature: 0.2,
          max_tokens: 700,
          messages: req.messages.map(toWire),
          ...(req.tools?.length ? { tools: req.tools.map((t) => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: t.parameters } })) } : {}),
          ...(req.jsonMode ? { response_format: { type: 'json_object' as const } } : {}),
        });
        const m = r.choices[0]?.message;
        return {
          content: m?.content ?? null,
          toolCalls: (m?.tool_calls ?? []).flatMap((c) => (c.type === 'function' ? [{ id: c.id, name: c.function.name, arguments: c.function.arguments }] : [])),
          totalTokens: r.usage?.total_tokens ?? 0,
        };
      } catch (e) {
        const err = e as { status?: number; message?: string };
        if (req.tools?.length && err.status === 400 && /tool|function/i.test(err.message ?? '')) throw new ToolsUnsupportedError(err.message);
        throw e;
      }
    },
  };
}

function toWire(m: ChatMessage) {
  if (m.role === 'assistant')
    return { role: 'assistant' as const, content: m.content, ...(m.tool_calls?.length ? { tool_calls: m.tool_calls.map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: c.arguments } })) } : {}) };
  if (m.role === 'tool') return { role: 'tool' as const, tool_call_id: m.tool_call_id, content: m.content };
  return { role: m.role, content: m.content };
}
