import type { LlmClient, LlmRequest, LlmResponse } from '../../supabase/functions/_shared/ai/types';

/**
 * HARNESS-ONLY stand-in for a language model: keyword rules that pick a tool and then phrase the
 * tool's JSON result. It exists so the UI → Edge-Function core → database path can be exercised
 * without a provider. It says nothing about how a real model behaves (see ACCEPTANCE.md).
 */
export function harnessLlm(): LlmClient {
  return {
    async chat(req: LlmRequest): Promise<LlmResponse> {
      const msgs = req.messages;
      const last = [...msgs].reverse().find((m) => m.role === 'user') as { content: string } | undefined;
      const q = (last?.content ?? '').toLowerCase();
      const toolMsg = [...msgs].reverse().find((m) => m.role === 'tool') as { content: string } | undefined;
      const id = () => 'h' + msgs.length;
      const base = { content: null, toolCalls: [], totalTokens: 12 } as LlmResponse;
      const names = new Set((req.tools ?? []).map((t) => t.name));
      const pick = (name: string, args: unknown): LlmResponse => ({ ...base, toolCalls: [{ id: id(), name, arguments: JSON.stringify(args) }] });

      if (!toolMsg) {
        if (/недел|приех/.test(q) && names.has('get_stats')) return pick('get_stats', { period: 'week' });
        if (/получ|денег|выруч/.test(q) && names.has('get_stats')) return pick('get_stats', { period: 'month' });
        if (/завтра|запис/.test(q) && names.has('list_bookings')) {
          const d = new Date(Date.now() + 86400_000).toISOString().slice(0, 10);
          return pick('list_bookings', { from_date: d, to_date: d });
        }
        if (names.has('get_studio_info')) return pick('get_studio_info', {});
        return { ...base, content: 'Я могу рассказать об услугах и ценах.' };
      }
      const body = /<tool_result[^>]*>\n([\s\S]*?)\n<\/tool_result>/.exec(toolMsg.content)?.[1] ?? '{}';
      let data: any;
      try { data = JSON.parse(body); } catch { data = {}; }
      if (data.error) return { ...base, content: 'Не удалось получить данные для ответа.' };
      if (data.services) return { ...base, content: `Услуги: ${data.services.map((s: any) => `${s.name} — ${s.price_rub} ₽`).join('; ')}. Адрес: ${data.address ?? 'не указан'}.` };
      if ('arrived_cars' in data) return { ...base, content: `За период ${data.period.from} — ${data.period.to} (${data.timezone}): приехали ${data.arrived_cars}, выполнено ${data.completed_jobs}, получено денег ${data.money_received_rub} ₽. Ещё не подтверждено на ${data.planned_unconfirmed_value_rub} ₽ — это план, а не выручка.` };
      if (Array.isArray(data)) return { ...base, content: data.length ? `Записи: ${data.map((b: any) => `${b.start_local} ${b.service} (${b.customer})`).join('; ')}` : 'На этот день записей нет.' };
      return { ...base, content: 'Готово.' };
    },
  };
}
