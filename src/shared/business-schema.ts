import { z } from 'zod';

/**
 * The single input that dresses the app for one business.
 * tenants/<slug>/business.json is validated against this schema by the pipeline.
 * Nothing about a studio lives anywhere else in the source code.
 */

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'ожидается время ЧЧ:ММ');
const key = z.string().regex(/^[a-z0-9][a-z0-9-]{0,38}$/, 'ключ: латиница, цифры, дефис');
const mediaPath = z
  .string()
  .regex(/^media\/[A-Za-z0-9._-]+\.(jpe?g|png|webp)$/i, 'путь вида media/имя.jpg|png|webp');

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

const interval = z.tuple([hhmm, hhmm]).refine(([a, b]) => b > a, 'закрытие должно быть позже открытия');

export const isValidTimeZone = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

export const businessSchema = z
  .object({
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/, 'slug: 3–40 символов, латиница, цифры, дефис'),
    name: z.string().min(2).max(80),
    tagline: z.string().max(200).default(''),
    description: z.string().max(1200).default(''),
    timezone: z.string().refine(isValidTimeZone, 'неизвестный часовой пояс IANA'),
    accent: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'цвет вида #RRGGBB'),
    isDemo: z.boolean().default(false),
    contacts: z.object({
      address: z.string().min(3).max(200),
      phone: z.string().regex(/^\+?[0-9 ()-]{10,20}$/, 'телефон вида +7 495 000-00-00'),
    }),
    images: z.object({
      logo: mediaPath,
      hero: mediaPath,
      heroAlt: z.string().min(2).max(160),
    }),
    booking: z
      .object({
        slotStepMinutes: z.number().int().min(5).max(240).default(30),
        leadTimeMinutes: z.number().int().min(0).max(20160).default(120),
        cancelBeforeHours: z.number().int().min(0).max(720).default(24),
        maxHorizonDays: z.number().int().min(1).max(365).default(60),
      })
      .prefault({}),
    hours: z.object(
      Object.fromEntries(WEEKDAYS.map((d) => [d, interval.nullable()])) as Record<Weekday, z.ZodNullable<typeof interval>>,
    ),
    resources: z
      .array(z.object({ key, name: z.string().min(1).max(60) }))
      .min(1)
      .max(20),
    services: z
      .array(
        z.object({
          key,
          name: z.string().min(2).max(80),
          description: z.string().max(600).default(''),
          price: z.number().int().min(0).max(10_000_000),
          durationMinutes: z.number().int().min(5).max(20160),
          bufferMinutes: z.number().int().min(0).max(1440).default(0),
          resources: z.array(key).optional(),
        }),
      )
      .min(1)
      .max(40),
    cards: z.array(z.object({ title: z.string().min(1).max(60), body: z.string().max(300) })).length(3),
    gallery: z
      .array(z.object({ key, image: mediaPath, caption: z.string().max(120).default('') }))
      .max(12),
    owner: z.object({ email: z.string().email() }),
  })
  .superRefine((cfg, ctx) => {
    const dup = (items: { key: string }[], path: string) => {
      const seen = new Set<string>();
      items.forEach((it, i) => {
        if (seen.has(it.key)) ctx.addIssue({ code: 'custom', path: [path, i, 'key'], message: `повтор ключа «${it.key}»` });
        seen.add(it.key);
      });
    };
    dup(cfg.resources, 'resources');
    dup(cfg.services, 'services');
    dup(cfg.gallery, 'gallery');
    const known = new Set(cfg.resources.map((r) => r.key));
    cfg.services.forEach((s, i) =>
      s.resources?.forEach((rk, j) => {
        if (!known.has(rk)) ctx.addIssue({ code: 'custom', path: ['services', i, 'resources', j], message: `нет бокса «${rk}»` });
      }),
    );
    if (WEEKDAYS.every((d) => cfg.hours[d] === null)) {
      ctx.addIssue({ code: 'custom', path: ['hours'], message: 'нужен хотя бы один рабочий день' });
    }
  });

export type BusinessConfig = z.infer<typeof businessSchema>;
