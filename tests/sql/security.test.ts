import { beforeAll, describe, expect, it } from 'vitest';
import { admin, anon, book, localSlot, makeTenant, owner, rpc, service, sql, uuid, type Fixture } from './helpers';

let A: Fixture;
let B: Fixture;
let bookingB: { booking: { id: string }; access_token: string };
let bookingA: { booking: { id: string }; access_token: string };

beforeAll(async () => {
  A = await makeTenant();
  B = await makeTenant();
  bookingA = await book(A, 'wash', await localSlot(A.tz, 2, '10:00'));
  bookingB = await book(B, 'wash', await localSlot(B.tz, 2, '10:00'));
});

const denied = { code: '42501' };

describe('anon has no direct table access', () => {
  for (const table of ['tenants', 'bookings', 'payments', 'push_subscriptions', 'notification_jobs',
    'resource_occupancies', 'rate_limits', 'llm_usage', 'services', 'working_hours', 'tenant_members', 'gallery_items']) {
    it(`cannot read ${table}`, async () => {
      await expect(sql(anon(), `select * from public.${table} limit 1`)).rejects.toMatchObject(denied);
    });
  }
  it('cannot read server secrets', async () => {
    await expect(sql(anon(), `select * from private.secrets`)).rejects.toMatchObject(denied);
    await expect(sql(owner(A.ownerId), `select * from private.secrets`)).rejects.toMatchObject(denied);
  });
  it('cannot write anything', async () => {
    await expect(sql(anon(), `update public.tenants set name = 'x'`)).rejects.toMatchObject(denied);
    await expect(sql(anon(), `delete from public.bookings`)).rejects.toMatchObject(denied);
  });
});

describe('owners never touch bookings, payments or tokens directly', () => {
  for (const table of ['bookings', 'payments', 'push_subscriptions', 'notification_jobs', 'resource_occupancies', 'rate_limits', 'llm_usage']) {
    it(`authenticated cannot read ${table}`, async () => {
      await expect(sql(owner(A.ownerId), `select * from public.${table} limit 1`)).rejects.toMatchObject(denied);
    });
  }
});

describe('tenant isolation', () => {
  it("owner A is refused B's data through every owner RPC", async () => {
    const o = owner(A.ownerId);
    const from = new Date(Date.now() - 86400_000).toISOString();
    const to = new Date(Date.now() + 30 * 86400_000).toISOString();
    await expect(rpc(o, 'owner_context', [B.slug])).rejects.toMatchObject(denied);
    await expect(rpc(o, 'owner_bookings', [B.slug, from, to, false])).rejects.toMatchObject(denied);
    await expect(rpc(o, 'owner_stats', [B.slug, '2026-01-01', '2026-12-31'])).rejects.toMatchObject(denied);
    await expect(rpc(o, 'owner_close_day', [B.slug, '2027-01-04', ''])).rejects.toMatchObject(denied);
  });

  it("a booking id from B used under A's slug is simply not found", async () => {
    const o = owner(A.ownerId);
    expect(await rpc(o, 'owner_cancel_booking', [A.slug, bookingB.booking.id])).toMatchObject({ ok: false, code: 'not_found' });
    expect(await rpc(o, 'owner_set_status', [A.slug, bookingB.booking.id, 'done'])).toMatchObject({ ok: false, code: 'not_found' });
    expect(await rpc(o, 'owner_add_payment', [A.slug, bookingB.booking.id, 'payment', 100, 'cash', '', null])).toMatchObject({ ok: false, code: 'not_found' });
    expect(await rpc(o, 'owner_move_booking', [A.slug, bookingB.booking.id, await localSlot(A.tz, 3, '10:00'), null])).toMatchObject({ ok: false, code: 'not_found' });
    const [{ status }] = await admin(`select status from bookings where id = $1`, [bookingB.booking.id]);
    expect(status).toBe('booked');
  });

  it('a signed-in user who owns no studio is refused', async () => {
    await expect(rpc(owner(uuid()), 'owner_context', [A.slug])).rejects.toMatchObject(denied);
    await expect(rpc(anon(), 'owner_context', [A.slug])).rejects.toMatchObject(denied);
  });

  it("direct writes into another tenant's catalog are blocked by RLS", async () => {
    const o = owner(A.ownerId);
    await expect(
      sql(o, `insert into services (tenant_id, name, price_cents, duration_minutes) values ($1, 'Подмена', 1, 30)`, [B.id]),
    ).rejects.toMatchObject(denied);
    const seen = await sql(o, `select tenant_id from services`);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((r) => r.tenant_id === A.id)).toBe(true);
    const upd = await sql(o, `update services set price_cents = 1 where tenant_id = $1 returning id`, [B.id]);
    expect(upd).toHaveLength(0);
  });

  it('owners can edit presentation fields but not status, slug or the demo flag', async () => {
    const o = owner(A.ownerId);
    await sql(o, `update tenants set name = 'Новое имя', address = 'ул. Тестовая, 1' where id = $1`, [A.id]);
    await expect(sql(o, `update tenants set status = 'live' where id = $1`, [A.id])).rejects.toMatchObject(denied);
    await expect(sql(o, `update tenants set slug = 'hijack' where id = $1`, [A.id])).rejects.toMatchObject(denied);
    await expect(sql(o, `update tenants set is_demo = false where id = $1`, [A.id])).rejects.toMatchObject(denied);
    await expect(sql(o, `insert into tenant_members (tenant_id, user_id) values ($1, $2)`, [B.id, A.ownerId])).rejects.toMatchObject(denied);
  });

  it('composite foreign keys refuse cross-tenant references even for a privileged writer', async () => {
    await expect(
      admin(`insert into bookings (tenant_id, service_id, resource_id, service_name, price_cents, duration_minutes,
              buffer_minutes, starts_at, customer_name, customer_phone)
             values ($1, $2, $3, 'x', 1, 30, 0, now(), 'Иван Иванов', '+79000000000')`,
        [A.id, B.services.wash, A.resources[0]]),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      admin(`insert into resource_occupancies (tenant_id, resource_id, kind, during)
             values ($1, $2, 'block', tstzrange(now(), now() + interval '1 hour', '[)'))`, [A.id, B.resources[0].replace(/^./, 'a') && B.resources[0]]),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it("one studio's token never opens another's booking and reveals no payments", async () => {
    const mine = await rpc(anon(), 'my_booking', [bookingA.access_token]);
    expect(mine.studio.slug).toBe(A.slug);
    expect(mine.booking.id).toBe(bookingA.booking.id);
    expect(JSON.stringify(mine)).not.toMatch(/paid|payment|refund/i);
    expect(JSON.stringify(mine)).not.toContain(B.slug);
  });
});

describe('function privileges', () => {
  it('server-only functions are closed to anon and authenticated', async () => {
    for (const ctx of [anon(), owner(A.ownerId)]) {
      await expect(rpc(ctx, 'llm_reserve', [A.id, 10, 1000])).rejects.toMatchObject(denied);
      await expect(rpc(ctx, 'rate_hit', ['x', 1, 60])).rejects.toMatchObject(denied);
      await expect(rpc(ctx, 'claim_notification_jobs', [5, 60])).rejects.toMatchObject(denied);
      await expect(rpc(ctx, 'purge_expired', [])).rejects.toMatchObject(denied);
    }
    expect(await rpc(service, 'rate_hit', ['sec-test', 5, 60])).toBe(true);
  });

  it('anon cannot call owner RPCs and cannot reach the private schema', async () => {
    await expect(rpc(anon(), 'owner_stats', [A.slug, '2026-01-01', '2026-01-02'])).rejects.toMatchObject(denied);
    await expect(sql(anon(), `select private.token_for($1, 'k')`, [A.id])).rejects.toMatchObject(denied);
    await expect(sql(owner(A.ownerId), `select private.token_for($1, 'k')`, [A.id])).rejects.toMatchObject(denied);
  });

  it('the public studio payload exposes no customer data', async () => {
    const r = await rpc(anon(), 'studio_public', [A.slug]);
    const text = JSON.stringify(r);
    expect(r.ok).toBe(true);
    expect(text).not.toMatch(/customer|phone":"\+7900|access_token|payment/);
    expect(Object.keys(r.studio)).not.toContain('id');
  });
});
