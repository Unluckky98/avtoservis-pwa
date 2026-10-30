/**
 * Calendar periods in a studio's own timezone. Used by the owner screens AND by the AI assistant,
 * so "last 7 days" always means exactly the same range in both. No dependencies: runs in the
 * browser, Node and Deno.
 */
export type PeriodKey = 'today' | 'yesterday' | 'week' | 'month';

export const PERIODS: Record<PeriodKey, { label: string; backDays: number; endBack: number }> = {
  today: { label: 'Сегодня', backDays: 0, endBack: 0 },
  yesterday: { label: 'Вчера', backDays: 1, endBack: 1 },
  week: { label: '7 дней', backDays: 6, endBack: 0 },
  month: { label: '30 дней', backDays: 29, endBack: 0 },
};

export function todayKey(tz: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function addDaysKey(key: string, n: number): string {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function periodRange(p: PeriodKey, tz: string, now: Date = new Date()): { from: string; to: string } {
  const today = todayKey(tz, now);
  const def = PERIODS[p];
  return { from: addDaysKey(today, -def.backDays), to: addDaysKey(today, -def.endBack) };
}

export const isDateKey = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
