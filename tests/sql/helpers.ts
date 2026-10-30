import { randomUUID } from 'node:crypto';
import pg from 'pg';

export const pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL, max: 30 });

export type Ctx = { role: 'anon' | 'authenticated' | 'service_role'; sub?: string; ip?: string };
export const anon = (ip?: string): Ctx => ({ role: 'anon', ip });
export const owner = (sub: string): Ctx => ({ role: 'authenticated', sub });
export const service: Ctx = { role: 'service_role' };

/** Run one statement the way PostgREST would: switch role, set JWT claims, commit. */
export async function sql<T = any>(ctx: Ctx, text: string, args: unknown[] = []): Promise<T[]> {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query(`set local role ${ctx.role}`);
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: ctx.sub ?? null, role: ctx.role }),
    ]);
    if (ctx.ip) {
      await c.query(`select set_config('request.headers', $1, true)`, [
        JSON.stringify({ 'x-forwarded-for': ctx.ip }),
      ]);
    }
    const r = await c.query(text, args as any[]);
    await c.query('commit');
    return r.rows;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

export async function rpc<T = any>(ctx: Ctx, fn: string, args: unknown[] = []): Promise<T> {
  const ph = args.map((_, i) => `$${i + 1}`).join(', ');
  const rows = await sql(ctx, `select public.${fn}(${ph}) as r`, args);
  return rows[0].r as T;
}

/** Superuser access for fixtures and for asserting what the database really holds. */
export async function admin<T = any>(text: string, args: unknown[] = []): Promise<T[]> {
  return (await pool.query(text, args as any[])).rows;
}

export const uuid = () => randomUUID();
export const idemKey = () => `k-${randomUUID()}`;

export type Fixture = {
  id: string;
  slug: string;
  tz: string;
  ownerId: string;
  resources: string[];
  services: Record<string, string>;
};

/**
 * One isolated studio per test file/case. Mon–Sat 09:00–20:00, Sunday closed.
 * Services: wash (60 min, 15 buffer, 2 000), polish (2 days, 18 000), quick (30 min, 500).
 */
export async function makeTenant(opts: { boxes?: number; tz?: string; status?: 'live' | 'preview'; cancelHours?: number } = {}): Promise<Fixture> {
  const slug = `t-${randomUUID().slice(0, 12)}`;
  const tz = opts.tz ?? 'Europe/Moscow';
  const ownerId = uuid();
  const [{ id }] = await admin(
    `insert into tenants (slug, name, timezone, status, lead_time_minutes, cancel_before_hours, is_demo)
     values ($1, $2, $3, $4, 60, $5, true) returning id`,
    [slug, `Studio ${slug}`, tz, opts.status ?? 'live', opts.cancelHours ?? 24],
  );
  await admin(`insert into tenant_members (tenant_id, user_id) values ($1, $2)`, [id, ownerId]);
  for (let d = 1; d <= 6; d++) {
    await admin(`insert into working_hours (tenant_id, weekday, opens, closes) values ($1, $2, '09:00', '20:00')`, [id, d]);
  }
  const resources: string[] = [];
  for (let i = 1; i <= (opts.boxes ?? 1); i++) {
    const [r] = await admin(`insert into resources (tenant_id, name, sort) values ($1, $2, $3) returning id`, [id, `Бокс ${i}`, i]);
    resources.push(r.id);
  }
  const services: Record<string, string> = {};
  for (const [key, name, price, dur, buf] of [
    ['wash', 'Мойка', 200000, 60, 15],
    ['polish', 'Полировка', 1800000, 2880, 0],
    ['quick', 'Антидождь', 50000, 30, 0],
  ] as const) {
    const [s] = await admin(
      `insert into services (tenant_id, name, price_cents, duration_minutes, buffer_minutes)
       values ($1, $2, $3, $4, $5) returning id`,
      [id, name, price, dur, buf],
    );
    services[key] = s.id;
  }
  return { id, slug, tz, ownerId, resources, services };
}

/** A future weekday at hh:mm in the tenant's timezone, as an ISO instant. weeksAhead >= 1. */
export async function localSlot(tz: string, isoDow: number, hhmm: string, weeksAhead = 1): Promise<string> {
  const [{ t }] = await admin(
    `select to_char(
       ((date_trunc('week', now() at time zone $1) + make_interval(weeks => $2, days => $3 - 1)
         + $4::time) at time zone $1) at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as t`,
    [tz, weeksAhead, isoDow, hhmm],
  );
  return t;
}

const rnd = () => Math.floor(Math.random() * 250) + 1;
export const person = (n = 1) => ({ name: `Клиент ${n}`, phone: `+7 900 000-00-${String(n).padStart(2, '0')}`, car: 'Audi A6' });

export async function book(f: Fixture, svc: string, startIso: string, extra: Partial<{ key: string; name: string; phone: string; car: string; ip: string }> = {}) {
  const p = person(Math.floor(Math.random() * 90) + 10);
  const ip = extra.ip ?? `10.${rnd()}.${rnd()}.${rnd()}`;
  return rpc(anon(ip), 'create_booking', [
    f.slug, f.services[svc] ?? svc, startIso, extra.name ?? p.name, extra.phone ?? p.phone, extra.car ?? p.car, extra.key ?? idemKey(),
  ]);
}
