import { z } from 'zod';
import { ownerClient } from '../../lib/supabase';
import { ApiError } from '../../lib/api';

export const OWNER_ERRORS: Record<string, string> = {
  slot_taken: 'Это время занято. Выберите другое.',
  not_movable: 'Эту запись нельзя перенести.',
  not_cancellable: 'Эту запись нельзя отменить.',
  bad_transition: 'Такой переход статуса недоступен.',
  refund_exceeds_received: 'Возврат больше, чем получено по записи.',
  booking_cancelled: 'Запись отменена, оплату добавить нельзя.',
  bad_amount: 'Укажите сумму больше нуля.',
  invalid_name: 'Укажите имя клиента.',
  invalid_phone: 'Проверьте номер телефона.',
  overlaps_existing: 'В это время уже есть запись или блок.',
  bad_range: 'Проверьте даты.',
  service_not_found: 'Услуга не найдена.',
  resource_not_found: 'Бокс не найден.',
  not_found: 'Не найдено.',
};

export class ForbiddenError extends Error {}

async function call<S extends z.ZodTypeAny>(slug: string, fn: string, args: Record<string, unknown>, schema: S): Promise<z.infer<S>> {
  const { data, error } = await ownerClient(slug).rpc(fn, { p_slug: slug, ...args });
  if (error) {
    if (error.code === '42501' || /forbidden/i.test(error.message)) throw new ForbiddenError('Нет доступа к кабинету этой студии.');
    throw new ApiError('network', 'Нет связи с сервером или сессия истекла. Повторите.');
  }
  const r = z.union([schema, z.object({ ok: z.literal(false), code: z.string() })]).safeParse(data);
  if (!r.success) throw new ApiError('bad_response', 'Сервер вернул неожиданный ответ.');
  const out = r.data as any;
  if (out.ok === false) throw new ApiError(out.code, OWNER_ERRORS[out.code] ?? 'Не удалось выполнить действие.');
  return out;
}

const ok = z.object({ ok: z.literal(true) }).passthrough();

export const ownerBooking = z.object({
  id: z.string(), service_id: z.string(), service_name: z.string(), resource_id: z.string(), resource: z.string(),
  starts_at: z.string(), ends_at: z.string(), occupied_until: z.string(),
  customer_name: z.string(), customer_phone: z.string(), car: z.string().nullable().optional(),
  status: z.string(), source: z.string().optional(), price_cents: z.number(), paid_cents: z.number(),
});
export type OwnerBooking = z.infer<typeof ownerBooking>;

const block = z.object({ id: z.string(), resource_id: z.string(), resource: z.string(), from: z.string(), to: z.string(), reason: z.string().nullable().optional() });
export type Block = z.infer<typeof block>;

export const ownerContext = z.object({
  ok: z.literal(true),
  tenant: z.object({
    id: z.string().optional(), slug: z.string(), name: z.string(), tagline: z.string().nullable(), description: z.string().nullable(), timezone: z.string(), status: z.string(),
    accent: z.string(), address: z.string().nullable(), phone: z.string().nullable(), slot_step_minutes: z.number(), lead_time_minutes: z.number(),
    cancel_before_hours: z.number(), max_horizon_days: z.number(),
  }).passthrough(),
  resources: z.array(z.object({ id: z.string(), name: z.string(), active: z.boolean().optional() }).passthrough()),
  services: z.array(z.object({ id: z.string(), name: z.string(), price_cents: z.number(), duration_minutes: z.number(), buffer_minutes: z.number(), active: z.boolean() }).passthrough()),
  hours: z.array(z.object({ weekday: z.number(), opens: z.string(), closes: z.string() })),
  days_off: z.array(z.object({ day: z.string(), reason: z.string().nullable().optional() })),
  gallery: z.array(z.object({ id: z.string(), image_url: z.string(), caption: z.string().nullable(), origin: z.string() })),
});
export type OwnerContext = z.infer<typeof ownerContext>;

export const getContext = (slug: string) => call(slug, 'owner_context', {}, ownerContext);

export const getBookings = (slug: string, from: string, to: string, includeCancelled = true) =>
  call(slug, 'owner_bookings', { p_from: from, p_to: to, p_include_cancelled: includeCancelled }, z.object({ ok: z.literal(true), timezone: z.string(), bookings: z.array(ownerBooking), blocks: z.array(block) }));

export const getStats = (slug: string, from: string, to: string) =>
  call(slug, 'owner_stats', { p_from: from, p_to: to }, z.object({
    ok: z.literal(true), timezone: z.string(), from: z.string(), to: z.string(), arrivals: z.number(), completed: z.number(), completed_value_cents: z.number(),
    received_cents: z.number(), payments_cents: z.number(), refunds_cents: z.number(), scheduled_count: z.number(), scheduled_value_cents: z.number(),
  }));

export const createOwnerBooking = (slug: string, a: { serviceId: string; startsAt: string; name: string; phone: string; car: string; resourceId: string | null; key: string }) =>
  call(slug, 'owner_create_booking', { p_service_id: a.serviceId, p_starts_at: a.startsAt, p_name: a.name, p_phone: a.phone, p_car: a.car, p_resource_id: a.resourceId, p_idempotency_key: a.key }, ok);
export const moveBooking = (slug: string, id: string, startsAt: string, resourceId: string | null) =>
  call(slug, 'owner_move_booking', { p_booking_id: id, p_new_starts_at: startsAt, p_resource_id: resourceId }, ok);
export const cancelOwnerBooking = (slug: string, id: string) => call(slug, 'owner_cancel_booking', { p_booking_id: id }, ok);
export const setStatus = (slug: string, id: string, status: 'booked' | 'accepted' | 'done') => call(slug, 'owner_set_status', { p_booking_id: id, p_status: status }, ok);
export const addPayment = (slug: string, a: { id: string; kind: 'payment' | 'refund'; cents: number; method: string; note: string; key: string }) =>
  call(slug, 'owner_add_payment', { p_booking_id: a.id, p_kind: a.kind, p_amount_cents: a.cents, p_method: a.method, p_note: a.note, p_idempotency_key: a.key }, ok);
export const blockResource = (slug: string, resourceId: string, from: string, to: string, reason: string) =>
  call(slug, 'owner_block_resource', { p_resource_id: resourceId, p_from: from, p_to: to, p_reason: reason }, ok);
export const unblock = (slug: string, id: string) => call(slug, 'owner_unblock', { p_occupancy_id: id }, ok);
export const closeDay = (slug: string, day: string, reason: string) => call(slug, 'owner_close_day', { p_day: day, p_reason: reason }, ok);
export const reopenDay = (slug: string, day: string) => call(slug, 'owner_reopen_day', { p_day: day }, ok);

/** Catalog edits go straight to tables; Row Level Security limits them to the owner's own studio. */
export async function table<T>(slug: string, run: (c: ReturnType<typeof ownerClient>) => PromiseLike<{ data: T | null; error: { message: string; code?: string } | null }>): Promise<T | null> {
  const { data, error } = await run(ownerClient(slug));
  if (error) throw new ApiError(error.code ?? 'db', 'Не удалось сохранить: ' + (error.code === '42501' ? 'нет прав.' : 'проверьте значения.'));
  return data;
}

const idCache = new Map<string, string>();
export async function tenantId(slug: string): Promise<string> {
  const hit = idCache.get(slug);
  if (hit) return hit;
  const rows = await table<{ id: string }[]>(slug, (c) => c.from('tenants').select('id').eq('slug', slug));
  const id = rows?.[0]?.id;
  if (!id) throw new ForbiddenError('Нет доступа к студии.');
  idCache.set(slug, id);
  return id;
}
export const forgetTenantIds = () => idCache.clear();
