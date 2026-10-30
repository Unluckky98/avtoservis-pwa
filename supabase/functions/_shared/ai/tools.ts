import { z } from 'zod';
import { type Mode, type Tool } from './types.ts';
import { addDaysKey, isDateKey, periodRange, type PeriodKey } from '../periods.ts';

/** Data providers are bound to ONE studio (and, for owners, to the caller's JWT) before the model ever runs. */
export type StudioInfo = {
  name: string; timezone: string; address: string | null; phone: string | null; cancel_before_hours: number;
  services: { id: string; name: string; price_cents: number; duration_minutes: number }[];
  hours: { weekday: number; opens: string; closes: string }[];
};
export type Providers = {
  studio(): Promise<StudioInfo>;
  availability(serviceId: string, from: string, to: string): Promise<{ start: string; available: boolean }[]>;
  stats?(from: string, to: string): Promise<Record<string, unknown>>;
  bookings?(fromIso: string, toIso: string): Promise<Record<string, unknown>[]>;
  timezone: string;
};

const dateKey = z.string().refine(isDateKey, 'дата в формате ГГГГ-ММ-ДД');

function tool<S extends z.ZodTypeAny>(name: string, description: string, schema: S, parameters: Record<string, unknown>, run: (v: z.infer<S>) => Promise<unknown>): Tool {
  return {
    spec: { name, description, parameters },
    validate(args) {
      const r = schema.safeParse(args);
      return r.success ? { ok: true, value: r.data } : { ok: false, error: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ').slice(0, 200) };
    },
    run: (v) => run(v as z.infer<S>),
  };
}

const rubles = (cents: number) => Math.round(cents / 100);

function studioTool(p: Providers): Tool {
  return tool('get_studio_info', 'Название, адрес, телефон, график работы, правила отмены и список услуг с ценами (в рублях) и длительностью.', z.object({}).strict(), { type: 'object', properties: {}, additionalProperties: false }, async () => {
    const s = await p.studio();
    return {
      name: s.name, address: s.address, phone: s.phone, timezone: s.timezone, cancel_before_hours: s.cancel_before_hours, hours: s.hours,
      services: s.services.map((x) => ({ id: x.id, name: x.name, price_rub: rubles(x.price_cents), duration_minutes: x.duration_minutes })),
    };
  });
}

function availabilityTool(p: Providers): Tool {
  return tool(
    'check_availability',
    'Свободное время для услуги на даты (не больше 14 дней). service_id берётся из get_studio_info.',
    z.object({ service_id: z.string().uuid(), from_date: dateKey, to_date: dateKey }).strict(),
    { type: 'object', properties: { service_id: { type: 'string' }, from_date: { type: 'string', description: 'ГГГГ-ММ-ДД' }, to_date: { type: 'string', description: 'ГГГГ-ММ-ДД' } }, required: ['service_id', 'from_date', 'to_date'], additionalProperties: false },
    async (v) => {
      if (v.to_date < v.from_date) throw new Error('to_date раньше from_date');
      if (v.to_date > addDaysKey(v.from_date, 13)) throw new Error('не больше 14 дней');
      const slots = await p.availability(v.service_id, v.from_date, v.to_date);
      const days: Record<string, string[]> = {};
      for (const s of slots) {
        if (!s.available) continue;
        const day = new Intl.DateTimeFormat('sv-SE', { timeZone: p.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(s.start));
        const time = new Intl.DateTimeFormat('ru-RU', { timeZone: p.timezone, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(s.start));
        (days[day] ??= []).push(time);
      }
      return { timezone: p.timezone, free_times_by_day: days };
    },
  );
}

function statsTool(p: Providers): Tool {
  const periods = ['today', 'yesterday', 'week', 'month'] as const;
  return tool(
    'get_stats',
    'Показатели за период по часовому поясу студии: приехали машин, выполнено работ, получено денег (оплаты минус возвраты), запланировано по неподтверждённым записям. «Запланировано» — это не выручка.',
    z.union([z.object({ period: z.enum(periods) }).strict(), z.object({ from_date: dateKey, to_date: dateKey }).strict()]),
    { type: 'object', properties: { period: { type: 'string', enum: [...periods] }, from_date: { type: 'string' }, to_date: { type: 'string' } }, additionalProperties: false },
    async (v) => {
      const range = 'period' in v ? periodRange(v.period as PeriodKey, p.timezone) : { from: v.from_date, to: v.to_date };
      const r = await p.stats!(range.from, range.to);
      return {
        period: range, timezone: p.timezone,
        arrived_cars: r.arrivals, completed_jobs: r.completed, completed_value_rub: rubles(Number(r.completed_value_cents ?? 0)),
        money_received_rub: rubles(Number(r.received_cents ?? 0)), payments_rub: rubles(Number(r.payments_cents ?? 0)), refunds_rub: rubles(Number(r.refunds_cents ?? 0)),
        planned_unconfirmed_count: r.scheduled_count, planned_unconfirmed_value_rub: rubles(Number(r.scheduled_value_cents ?? 0)),
        note: 'planned_* — ещё не подтверждённые записи, это план, а не выручка.',
      };
    },
  );
}

function bookingsTool(p: Providers): Tool {
  return tool(
    'list_bookings',
    'Записи за даты (не больше 14 дней) без телефонов клиентов: время, услуга, бокс, статус, имя, автомобиль, цена и оплачено.',
    z.object({ from_date: dateKey, to_date: dateKey }).strict(),
    { type: 'object', properties: { from_date: { type: 'string' }, to_date: { type: 'string' } }, required: ['from_date', 'to_date'], additionalProperties: false },
    async (v) => {
      if (v.to_date < v.from_date) throw new Error('to_date раньше from_date');
      if (v.to_date > addDaysKey(v.from_date, 13)) throw new Error('не больше 14 дней');
      // local midnight → instant, via the same offset trick as the UI (Intl only)
      const toIso = (day: string) => localMidnight(day, p.timezone);
      const rows = await p.bookings!(toIso(v.from_date), toIso(addDaysKey(v.to_date, 1)));
      return rows.slice(0, 60).map((b) => ({
        start_local: new Intl.DateTimeFormat('sv-SE', { timeZone: p.timezone, dateStyle: 'short', timeStyle: 'short' }).format(new Date(String(b.starts_at))),
        service: b.service_name, box: b.resource, status: b.status, customer: b.customer_name, car: b.car ?? null,
        price_rub: rubles(Number(b.price_cents ?? 0)), paid_rub: rubles(Number(b.paid_cents ?? 0)),
      }));
    },
  );
}

/** Instant of 00:00 on `day` in `tz` (DST-safe via a fixed-point offset lookup). */
export function localMidnight(day: string, tz: string): string {
  const guess = Date.parse(`${day}T00:00:00Z`);
  const offsetAt = (t: number) => {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(t));
    const g = (k: string) => Number(parts.find((x) => x.type === k)!.value);
    return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - t;
  };
  let t = guess - offsetAt(guess);
  t = guess - offsetAt(t);
  return new Date(t).toISOString();
}

/**
 * Tool sets are separated by mode. A client conversation can never reach owner tools, and the owner
 * set is read-only: the assistant describes what the owner could do, it does not change data.
 */
export function toolsFor(mode: Mode, p: Providers): Tool[] {
  if (mode === 'client') return [studioTool(p), availabilityTool(p)];
  return [studioTool(p), availabilityTool(p), statsTool(p), bookingsTool(p)];
}
