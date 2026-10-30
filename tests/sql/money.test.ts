import { describe, expect, it } from 'vitest';
import { admin, anon, book, idemKey, localSlot, makeTenant, owner, rpc } from './helpers';

const pay = (o: ReturnType<typeof owner>, slug: string, id: string, kind: string, amount: number, key: string | null = idemKey()) =>
  rpc(o, 'owner_add_payment', [slug, id, kind, amount, 'cash', '', key]);

describe('historical price', () => {
  it('a booking keeps the price and duration it was sold at', async () => {
    const f = await makeTenant({ boxes: 2 });
    const o = owner(f.ownerId);
    const t = await localSlot(f.tz, 2, '10:00');
    const r = await book(f, 'wash', t);
    await admin(`update services set price_cents = 999900, duration_minutes = 600, name = 'Мойка VIP' where id = $1`, [f.services.wash]);
    const from = new Date(Date.now() - 86400_000).toISOString();
    const to = new Date(Date.now() + 30 * 86400_000).toISOString();
    const list = await rpc(o, 'owner_bookings', [f.slug, from, to, false]);
    const b = list.bookings.find((x: any) => x.id === r.booking.id);
    expect(b.price_cents).toBe(200000);
    expect(b.service_name).toBe('Мойка');
    expect(new Date(b.ends_at).getTime() - new Date(b.starts_at).getTime()).toBe(60 * 60_000);
    const mine = await rpc(anon(), 'my_booking', [r.access_token]);
    expect(mine.booking.price_cents).toBe(200000);
    // a new booking uses the new price
    const r2 = await book(f, 'wash', await localSlot(f.tz, 3, '10:00'));
    expect(r2.booking.price_cents).toBe(999900);
  });

  it('the client cannot choose price, tenant or duration', async () => {
    const f = await makeTenant();
    // create_booking has no price/duration/tenant parameters at all
    const [{ args }] = await admin(
      `select pg_get_function_identity_arguments('public.create_booking(text, uuid, timestamptz, text, text, text, text)'::regprocedure) args`);
    expect(args).not.toMatch(/price|duration|tenant/i);
    void f;
  });
});

describe('payments and refunds', () => {
  it('records payments, rejects a refund above what was received, and is idempotent', async () => {
    const f = await makeTenant();
    const o = owner(f.ownerId);
    const r = await book(f, 'wash', await localSlot(f.tz, 2, '10:00'));
    const id = r.booking.id;

    expect(await pay(o, f.slug, id, 'payment', 50000)).toMatchObject({ ok: true, paid_cents: 50000, balance_cents: 150000 });
    const key = idemKey();
    const a = await pay(o, f.slug, id, 'payment', 30000, key);
    const b = await pay(o, f.slug, id, 'payment', 30000, key);
    expect(a.paid_cents).toBe(80000);
    expect(b.replayed).toBe(true);
    expect(b.paid_cents).toBe(80000);
    expect(await pay(o, f.slug, id, 'refund', 90000)).toMatchObject({ ok: false, code: 'refund_exceeds_received' });
    expect(await pay(o, f.slug, id, 'refund', 20000)).toMatchObject({ ok: true, paid_cents: 60000 });
    expect(await pay(o, f.slug, id, 'payment', 0)).toMatchObject({ ok: false, code: 'bad_amount' });
    expect(await rpc(o, 'owner_add_payment', [f.slug, id, 'payment', 100, 'crypto', '', null])).toMatchObject({ ok: false, code: 'bad_method' });
  });

  it('concurrent refunds cannot push the total refunded above the amount received', async () => {
    const f = await makeTenant();
    const o = owner(f.ownerId);
    const r = await book(f, 'wash', await localSlot(f.tz, 2, '10:00'));
    await pay(o, f.slug, r.booking.id, 'payment', 100000);
    const results = await Promise.all(Array.from({ length: 8 }, () => pay(o, f.slug, r.booking.id, 'refund', 40000)));
    expect(results.filter((x) => x.ok)).toHaveLength(2);
    const [{ net }] = await admin(
      `select sum(case kind when 'payment' then amount_cents else -amount_cents end)::int net from payments where booking_id = $1`, [r.booking.id]);
    expect(net).toBe(20000);
  });

  it('refuses new payments on a cancelled booking but allows refunding what was taken', async () => {
    const f = await makeTenant();
    const o = owner(f.ownerId);
    const r = await book(f, 'wash', await localSlot(f.tz, 2, '10:00'));
    await pay(o, f.slug, r.booking.id, 'payment', 70000);
    const c = await rpc(o, 'owner_cancel_booking', [f.slug, r.booking.id]);
    expect(c).toMatchObject({ ok: true, refund_due_cents: 70000 });
    expect(await pay(o, f.slug, r.booking.id, 'payment', 1000)).toMatchObject({ ok: false, code: 'booking_cancelled' });
    expect(await pay(o, f.slug, r.booking.id, 'refund', 70000)).toMatchObject({ ok: true, paid_cents: 0 });
  });
});

describe('statistics', () => {
  it('separates arrivals, completed work and received money; future value is not revenue', async () => {
    const f = await makeTenant({ boxes: 4 });
    const o = owner(f.ownerId);
    const day = (await localSlot(f.tz, 2, '10:00')).slice(0, 10);

    const planned = await book(f, 'wash', await localSlot(f.tz, 2, '09:00'));                 // stays 'booked'
    const arrived = await book(f, 'wash', await localSlot(f.tz, 2, '10:00'));                 // accepted
    const finished = await book(f, 'wash', await localSlot(f.tz, 2, '11:00'));                // done
    const cancelled = await book(f, 'wash', await localSlot(f.tz, 2, '12:00'));               // cancelled
    expect(planned.ok && arrived.ok && finished.ok && cancelled.ok).toBe(true);

    await rpc(o, 'owner_set_status', [f.slug, arrived.booking.id, 'accepted']);
    await rpc(o, 'owner_set_status', [f.slug, finished.booking.id, 'done']);
    await rpc(o, 'owner_cancel_booking', [f.slug, cancelled.booking.id]);
    await pay(o, f.slug, finished.booking.id, 'payment', 200000);
    await pay(o, f.slug, arrived.booking.id, 'payment', 50000);
    await pay(o, f.slug, arrived.booking.id, 'refund', 10000);

    const from = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
    const to = new Date(Date.now() + 60 * 86400_000).toISOString().slice(0, 10);
    const wide = await rpc(o, 'owner_stats', [f.slug, from, to]);
    expect(await rpc(o, 'owner_stats', [f.slug, '2020-01-01', '2100-01-01'])).toMatchObject({ ok: false, code: 'bad_range' });
    expect(wide).toMatchObject({
      ok: true,
      arrivals: 2,                       // accepted + done
      completed: 1,
      completed_value_cents: 200000,
      received_cents: 240000,            // 200000 + 50000 - 10000, nothing from the unpaid plan
      payments_cents: 250000,
      refunds_cents: 10000,
      scheduled_count: 1,                // the still-unconfirmed booking
      scheduled_value_cents: 200000,
    });
    // the future/unconfirmed value is reported under its own name and never mixed into received money
    expect(wide).not.toHaveProperty('revenue');
    void day;
  });

  it('periods follow the studio timezone, not UTC', async () => {
    const f = await makeTenant({ tz: 'Asia/Yekaterinburg' });
    const o = owner(f.ownerId);
    const early = await localSlot(f.tz, 3, '01:30');   // 01:30 local = 20:30Z of the previous UTC day
    const localDay = (await admin(`select (($1::timestamptz) at time zone 'Asia/Yekaterinburg')::date d`, [early]))[0].d as Date;
    const iso = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    const dayStr = iso(localDay);
    const prev = iso(new Date(localDay.getTime() - 86400_000));

    const m = await rpc(o, 'owner_create_booking', [f.slug, f.services.quick, early, 'Ночной клиент', '+79001230000', '', null, idemKey()]);
    expect(m.ok).toBe(true);
    await rpc(o, 'owner_set_status', [f.slug, m.booking.id, 'accepted']);

    const same = await rpc(o, 'owner_stats', [f.slug, dayStr, dayStr]);
    const before = await rpc(o, 'owner_stats', [f.slug, prev, prev]);
    expect(same.arrivals).toBe(1);
    expect(before.arrivals).toBe(0);
    expect(same.timezone).toBe('Asia/Yekaterinburg');
  });

  it('status changes follow allowed transitions only', async () => {
    const f = await makeTenant();
    const o = owner(f.ownerId);
    const r = await book(f, 'wash', await localSlot(f.tz, 2, '10:00'));
    expect(await rpc(o, 'owner_set_status', [f.slug, r.booking.id, 'done'])).toMatchObject({ ok: true });
    expect(await rpc(o, 'owner_set_status', [f.slug, r.booking.id, 'accepted'])).toMatchObject({ ok: false, code: 'bad_transition' });
    expect(await rpc(o, 'owner_cancel_booking', [f.slug, r.booking.id])).toMatchObject({ ok: false, code: 'not_cancellable' });
    expect(await rpc(o, 'owner_set_status', [f.slug, r.booking.id, 'bogus'])).toMatchObject({ ok: false, code: 'bad_status' });
  });
});
