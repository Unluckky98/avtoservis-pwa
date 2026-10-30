import { z } from 'zod';
import { supabase } from './supabase';

/** Human-readable messages for business error codes returned by the database. */
export const ERROR_TEXT: Record<string, string> = {
  slot_taken: 'Это время только что заняли. Выберите другое.',
  slot_unavailable: 'На это время записаться нельзя. Выберите другое.',
  rate_limited: 'Слишком много попыток. Подождите немного и повторите.',
  invalid_name: 'Укажите имя (от 2 символов).',
  invalid_phone: 'Проверьте номер телефона.',
  invalid_car: 'Слишком длинное название автомобиля.',
  not_found: 'Студия или запись не найдена.',
  service_not_found: 'Эта услуга больше недоступна.',
  too_late: 'Отменить уже нельзя: срок для отмены прошёл. Позвоните в студию.',
  not_cancellable: 'Эту запись уже нельзя отменить.',
  idempotency_conflict: 'Запрос повторился с другими данными. Обновите страницу и повторите.',
  bad_request: 'Не удалось обработать запрос. Обновите страницу.',
  not_active: 'Запись уже не активна.',
};
export const errorText = (code: string | undefined) => (code && ERROR_TEXT[code]) || 'Что-то пошло не так. Попробуйте ещё раз.';

export class ApiError extends Error {
  constructor(public code: string, message?: string) {
    super(message ?? errorText(code));
  }
}

async function rpc<S extends z.ZodTypeAny>(fn: string, args: Record<string, unknown>, schema: S): Promise<z.infer<S>> {
  const { data, error } = await supabase().rpc(fn, args);
  if (error) throw new ApiError('network', 'Нет связи с сервером. Проверьте интернет и повторите.');
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new ApiError('bad_response', 'Сервер вернул неожиданный ответ.');
  return parsed.data;
}

const fail = z.object({ ok: z.literal(false), code: z.string() });

// ------------------------------------------------------------------ studio
export const studioSchema = z.object({
  slug: z.string(),
  name: z.string(),
  tagline: z.string().nullable().default(''),
  description: z.string().nullable().default(''),
  timezone: z.string(),
  preview: z.boolean(),
  is_demo: z.boolean(),
  accent: z.string(),
  address: z.string().nullable(),
  phone: z.string().nullable(),
  logo_url: z.string().nullable(),
  hero_url: z.string().nullable(),
  hero_alt: z.string().nullable(),
  slot_step_minutes: z.number(),
  cancel_before_hours: z.number(),
  services: z.array(
    z.object({ id: z.string(), name: z.string(), description: z.string().nullable(), price_cents: z.number(), duration_minutes: z.number() }),
  ),
  gallery: z.array(z.object({ id: z.string(), image_url: z.string(), caption: z.string().nullable() })),
  cards: z.array(z.object({ position: z.number(), title: z.string(), body: z.string() })),
  hours: z.array(z.object({ weekday: z.number(), opens: z.string(), closes: z.string() })),
  days_off: z.array(z.string()),
});
export type Studio = z.infer<typeof studioSchema>;
export type Service = Studio['services'][number];

export async function getStudio(slug: string): Promise<Studio | null> {
  const r = await rpc('studio_public', { p_slug: slug }, z.union([z.object({ ok: z.literal(true), studio: studioSchema }), fail]));
  if (!r.ok) {
    if (r.code === 'not_found') return null;
    throw new ApiError(r.code);
  }
  return r.studio;
}

// ------------------------------------------------------------------ availability
const availSchema = z.union([
  z.object({ ok: z.literal(true), timezone: z.string(), slots: z.array(z.object({ start: z.string(), available: z.boolean() })) }),
  fail,
]);
export type Slot = { start: string; available: boolean };

export async function getAvailability(slug: string, serviceId: string, from: string, to: string): Promise<Slot[]> {
  const r = await rpc('availability', { p_slug: slug, p_service_id: serviceId, p_from: from, p_to: to }, availSchema);
  if (!r.ok) throw new ApiError(r.code);
  return r.slots;
}

// ------------------------------------------------------------------ bookings
export const bookingSchema = z.object({
  id: z.string(),
  status: z.string(),
  service_name: z.string(),
  price_cents: z.number(),
  starts_at: z.string(),
  ends_at: z.string(),
  duration_minutes: z.number(),
  resource: z.string().nullable().optional(),
  customer_name: z.string(),
  car: z.string().nullable().optional(),
});
export type Booking = z.infer<typeof bookingSchema>;

export type BookingInput = { slug: string; serviceId: string; startsAt: string; name: string; phone: string; car: string; key: string };

export async function createBooking(i: BookingInput): Promise<{ token: string; booking: Booking; replayed: boolean }> {
  const r = await rpc(
    'create_booking',
    { p_slug: i.slug, p_service_id: i.serviceId, p_starts_at: i.startsAt, p_name: i.name, p_phone: i.phone, p_car: i.car, p_idempotency_key: i.key },
    z.union([z.object({ ok: z.literal(true), replayed: z.boolean(), access_token: z.string(), booking: bookingSchema }), fail]),
  );
  if (!r.ok) throw new ApiError(r.code);
  return { token: r.access_token, booking: r.booking, replayed: r.replayed };
}

const myBookingSchema = z.union([
  z.object({
    ok: z.literal(true),
    booking: bookingSchema,
    studio: z.object({ slug: z.string(), name: z.string(), address: z.string().nullable(), phone: z.string().nullable(), timezone: z.string(), preview: z.boolean() }),
    cancel_deadline: z.string(),
    can_cancel: z.boolean(),
    cancel_before_hours: z.number(),
    reminder: z.boolean(),
  }),
  fail,
]);
export type MyBooking = Exclude<z.infer<typeof myBookingSchema>, { ok: false }>;

export async function getMyBooking(token: string): Promise<MyBooking | null> {
  const r = await rpc('my_booking', { p_token: token }, myBookingSchema);
  if (!r.ok) {
    if (r.code === 'not_found') return null;
    throw new ApiError(r.code);
  }
  return r;
}

export async function cancelMyBooking(token: string): Promise<void> {
  const r = await rpc('cancel_my_booking', { p_token: token }, z.union([z.object({ ok: z.literal(true) }).passthrough(), fail]));
  if (!r.ok) throw new ApiError(r.code);
}

export async function enableReminder(token: string, sub: { endpoint: string; p256dh: string; auth: string }) {
  const r = await rpc(
    'enable_reminder',
    { p_token: token, p_endpoint: sub.endpoint, p_p256dh: sub.p256dh, p_auth: sub.auth },
    z.union([z.object({ ok: z.literal(true), enabled: z.boolean(), reason: z.string().optional(), run_at: z.string().optional() }), fail]),
  );
  if (!r.ok) throw new ApiError(r.code);
  return r;
}
