import { describe, expect, it } from 'vitest';
import { admin, anon, book, idemKey, localSlot, makeTenant, owner, person, rpc } from './helpers';

const iso = (x: string) => new Date(x).toISOString().replace('.000Z', 'Z');
const slotsOf = (r: any) =>
  (r.slots as { start: string; available: boolean }[]).map((s) => ({ ...s, start: iso(s.start) }));

describe('availability from the real schedule', () => {
  it('lists working-hour slots, hides Sunday and closed days, marks taken time', async () => {
    const f = await makeTenant();
    const monday = await localSlot(f.tz, 1, '10:00');
    const day = monday.slice(0, 10);

    const before = await rpc(anon(), 'availability', [f.slug, f.services.wash, day, day]);
    expect(before.ok).toBe(true);
    const starts = slotsOf(before).map((s) => s.start);
    expect(starts).toContain(monday);
    expect(slotsOf(before).every((s) => s.available)).toBe(true);
    // 60-minute service must end by 20:00 local => last start 19:00 (30-min step) => 19:00 is the last
    const lastLocal = new Date(starts.at(-1)!).toLocaleTimeString('ru-RU', { timeZone: f.tz, hour: '2-digit', minute: '2-digit' });
    expect(lastLocal).toBe('19:00');

    const sunday = await localSlot(f.tz, 7, '10:00');
    const sun = await rpc(anon(), 'availability', [f.slug, f.services.wash, sunday.slice(0, 10), sunday.slice(0, 10)]);
    expect(slotsOf(sun)).toHaveLength(0);

    const res = await book(f, 'wash', monday);
    expect(res.ok).toBe(true);
    const after = slotsOf(await rpc(anon(), 'availability', [f.slug, f.services.wash, day, day]));
    // wash 60 + 15 buffer from 10:00 holds the box until 11:15: 10:00, 10:30, 11:00 are taken, 11:30 is free
    const stateAt = (h: string) => after.find((s) => s.start === new Date(`${day}T${h}:00+03:00`).toISOString().replace('.000Z', 'Z'))?.available;
    expect(stateAt('10:00')).toBe(false);
    expect(stateAt('10:30')).toBe(false);
    expect(stateAt('11:00')).toBe(false);
    expect(stateAt('11:30')).toBe(true);
    // 09:00 + 60 min + 15 min buffer would run into the 10:00 booking, so it is closed too
    expect(stateAt('09:00')).toBe(false);
    expect(stateAt('19:00')).toBe(true);
  });

  it('honours days off and the studio timezone (Asia/Yekaterinburg)', async () => {
    const f = await makeTenant({ tz: 'Asia/Yekaterinburg' });
    const tuesday = await localSlot(f.tz, 2, '09:00');
    const day = tuesday.slice(0, 10);
    const first = slotsOf(await rpc(anon(), 'availability', [f.slug, f.services.quick, day, day]))[0];
    // 09:00 local in UTC+5 is 04:00Z
    expect(first.start).toMatch(/T04:00:00Z$/);

    await rpc(owner(f.ownerId), 'owner_close_day', [f.slug, tuesday.slice(0, 10), 'Санитарный день']);
    const closed = await rpc(anon(), 'availability', [f.slug, f.services.quick, day, day]);
    expect(slotsOf(closed)).toHaveLength(0);
    const booked = await book(f, 'quick', tuesday);
    expect(booked.ok).toBe(false);
    expect(booked.code).toBe('slot_unavailable');
  });

  it('rejects start moments outside working hours and inside the lead time', async () => {
    const f = await makeTenant();
    const early = await localSlot(f.tz, 3, '07:00');
    expect((await book(f, 'quick', early)).code).toBe('slot_unavailable');
    const offGrid = await localSlot(f.tz, 3, '10:10');
    expect((await book(f, 'quick', offGrid)).code).toBe('slot_unavailable');
    const soon = new Date(Date.now() + 10 * 60_000).toISOString();
    expect((await book(f, 'quick', soon)).code).toBe('slot_unavailable');
  });
});

describe('atomic booking and double-booking protection', () => {
  it('only one of many simultaneous requests for the same box and time succeeds', async () => {
    const f = await makeTenant({ boxes: 1 });
    const t = await localSlot(f.tz, 2, '12:00');
    const results = await Promise.all(Array.from({ length: 12 }, () => book(f, 'wash', t)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).every((r) => r.code === 'slot_taken')).toBe(true);
    const [{ n }] = await admin(`select count(*)::int n from bookings where tenant_id = $1`, [f.id]);
    const [{ m }] = await admin(`select count(*)::int m from resource_occupancies where tenant_id = $1`, [f.id]);
    expect(n).toBe(1);
    expect(m).toBe(1);
  });

  it('two boxes: two parallel bookings succeed on different boxes, the third loses', async () => {
    const f = await makeTenant({ boxes: 2 });
    const t = await localSlot(f.tz, 2, '12:00');
    const results = await Promise.all(Array.from({ length: 5 }, () => book(f, 'wash', t)));
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    const boxes = results.filter((r) => r.ok).map((r) => r.booking.resource).sort();
    expect(boxes).toEqual(['Бокс 1', 'Бокс 2']);
  });

  it('a multi-day service holds the box for every day in between', async () => {
    const f = await makeTenant({ boxes: 1 });
    const mon = await localSlot(f.tz, 1, '10:00');
    const polish = await book(f, 'polish', mon);
    expect(polish.ok).toBe(true);
    // 2 880 minutes = 48 h: Mon 10:00 -> Wed 10:00
    expect(new Date(polish.booking.ends_at).getTime() - new Date(mon).getTime()).toBe(48 * 3600_000);

    const tuesday = await localSlot(f.tz, 2, '15:00');
    expect((await book(f, 'quick', tuesday)).code).toBe('slot_taken');
    const wedMorning = await localSlot(f.tz, 3, '09:30');
    expect((await book(f, 'quick', wedMorning)).code).toBe('slot_taken');
    const wedAfter = await localSlot(f.tz, 3, '10:00');
    expect((await book(f, 'quick', wedAfter)).ok).toBe(true);

    const day = tuesday.slice(0, 10);
    const av = slotsOf(await rpc(anon(), 'availability', [f.slug, f.services.quick, day, day]));
    expect(av.length).toBeGreaterThan(0);
    expect(av.every((s) => !s.available)).toBe(true);
  });

  it('a second box takes the load while the first is held for days', async () => {
    const f = await makeTenant({ boxes: 2 });
    const mon = await localSlot(f.tz, 1, '10:00');
    expect((await book(f, 'polish', mon)).booking.resource).toBe('Бокс 1');
    const tue = await localSlot(f.tz, 2, '12:00');
    const r = await book(f, 'wash', tue);
    expect(r.ok).toBe(true);
    expect(r.booking.resource).toBe('Бокс 2');
  });

  it('the database itself refuses an overlapping occupancy (EXCLUDE constraint)', async () => {
    const f = await makeTenant();
    const t = await localSlot(f.tz, 4, '11:00');
    const r = await book(f, 'wash', t);
    expect(r.ok).toBe(true);
    await expect(
      admin(`insert into resource_occupancies (tenant_id, resource_id, kind, during)
             values ($1, $2, 'block', tstzrange($3::timestamptz, $3::timestamptz + interval '10 minutes', '[)'))`,
        [f.id, f.resources[0], t]),
    ).rejects.toMatchObject({ code: '23P01' });
  });
});

describe('idempotency and access tokens', () => {
  it('a repeated request with the same key returns the same booking and the same access', async () => {
    const f = await makeTenant();
    const t = await localSlot(f.tz, 2, '13:00');
    const key = idemKey();
    const p = person(77);
    const args = [f.slug, f.services.wash, t, p.name, p.phone, p.car, key];
    const a = await rpc(anon('10.1.1.1'), 'create_booking', args);
    const b = await rpc(anon('10.1.1.1'), 'create_booking', args);
    expect(a.ok && b.ok).toBe(true);
    expect(b.replayed).toBe(true);
    expect(b.booking.id).toBe(a.booking.id);
    expect(b.access_token).toBe(a.access_token);
    const [{ n }] = await admin(`select count(*)::int n from bookings where tenant_id = $1`, [f.id]);
    expect(n).toBe(1);
  });

  it('double-click: simultaneous identical submissions create exactly one booking', async () => {
    const f = await makeTenant({ boxes: 3 });
    const t = await localSlot(f.tz, 2, '14:00');
    const key = idemKey();
    const p = person(78);
    const args = [f.slug, f.services.wash, t, p.name, p.phone, p.car, key];
    const rs = await Promise.all(Array.from({ length: 6 }, () => rpc(anon('10.2.2.2'), 'create_booking', args)));
    expect(rs.every((r) => r.ok)).toBe(true);
    expect(new Set(rs.map((r) => r.booking.id)).size).toBe(1);
    expect(new Set(rs.map((r) => r.access_token)).size).toBe(1);
    const [{ n }] = await admin(`select count(*)::int n from bookings where tenant_id = $1`, [f.id]);
    expect(n).toBe(1);
  });

  it('the same key with different data is a conflict, not a silent reuse', async () => {
    const f = await makeTenant({ boxes: 2 });
    const key = idemKey();
    const p = person(79);
    const t1 = await localSlot(f.tz, 2, '09:00');
    const t2 = await localSlot(f.tz, 2, '16:00');
    expect((await rpc(anon('10.3.3.3'), 'create_booking', [f.slug, f.services.wash, t1, p.name, p.phone, p.car, key])).ok).toBe(true);
    const clash = await rpc(anon('10.3.3.3'), 'create_booking', [f.slug, f.services.wash, t2, p.name, p.phone, p.car, key]);
    expect(clash).toMatchObject({ ok: false, code: 'idempotency_conflict' });
  });

  it('stores only a hash of the token and resolves the booking by the raw token', async () => {
    const f = await makeTenant();
    const t = await localSlot(f.tz, 5, '10:00');
    const r = await book(f, 'wash', t);
    const [row] = await admin(`select encode(access_token_hash, 'hex') h from bookings where id = $1`, [r.booking.id]);
    expect(row.h).not.toBe(r.access_token);
    expect(row.h).toHaveLength(64);
    const mine = await rpc(anon(), 'my_booking', [r.access_token]);
    expect(mine.ok).toBe(true);
    expect(mine.booking.id).toBe(r.booking.id);
    expect(mine.studio.name).toContain('Studio');
    expect((await rpc(anon(), 'my_booking', ['0'.repeat(64)])).ok).toBe(false);
    expect((await rpc(anon(), 'my_booking', ['short'])).ok).toBe(false);
  });

  it('validates input and returns structured errors', async () => {
    const f = await makeTenant();
    const t = await localSlot(f.tz, 5, '10:00');
    expect((await book(f, 'wash', t, { phone: '123' })).code).toBe('invalid_phone');
    expect((await book(f, 'wash', t, { name: 'А' })).code).toBe('invalid_name');
    expect((await book(f, 'wash', t, { key: 'short' })).code).toBe('bad_request');
    expect((await rpc(anon(), 'create_booking', ['nope', f.services.wash, t, 'Иван', '+79000000000', '', idemKey()])).code).toBe('not_found');
  });

  it('applies the per-phone booking rate limit', async () => {
    const f = await makeTenant({ boxes: 6 });
    const t = await localSlot(f.tz, 3, '09:00');
    const outcomes: string[] = [];
    for (let i = 0; i < 7; i++) {
      const r = await book(f, 'quick', await localSlot(f.tz, 3, `${String(9 + i).padStart(2, '0')}:00`), { phone: '+79001112233', ip: `10.9.9.${i + 1}` });
      outcomes.push(r.ok ? 'ok' : r.code);
    }
    expect(outcomes.filter((x) => x === 'ok')).toHaveLength(5);
    expect(outcomes.filter((x) => x === 'rate_limited')).toHaveLength(2);
    void t;
  });
});

describe('owner blocks, moves and cancellations', () => {
  it('blocking a box removes availability; a block cannot overlap a booking', async () => {
    const f = await makeTenant({ boxes: 1 });
    const o = owner(f.ownerId);
    const t = await localSlot(f.tz, 4, '10:00');
    const day = t.slice(0, 10);
    const from = await localSlot(f.tz, 4, '09:00');
    const to = await localSlot(f.tz, 4, '12:00');
    const blk = await rpc(o, 'owner_block_resource', [f.slug, f.resources[0], from, to, 'Ремонт подъёмника']);
    expect(blk.ok).toBe(true);
    const av = slotsOf(await rpc(anon(), 'availability', [f.slug, f.services.quick, day, day]));
    expect(av.filter((s) => s.start >= from && s.start < to).every((s) => !s.available)).toBe(true);
    expect((await book(f, 'quick', t)).code).toBe('slot_taken');

    const free = await localSlot(f.tz, 4, '15:00');
    expect((await book(f, 'quick', free)).ok).toBe(true);
    const clash = await rpc(o, 'owner_block_resource', [f.slug, f.resources[0], await localSlot(f.tz, 4, '14:30'), await localSlot(f.tz, 4, '16:00'), 'x']);
    expect(clash).toMatchObject({ ok: false, code: 'overlaps_existing' });

    expect((await rpc(o, 'owner_unblock', [f.slug, blk.id])).removed).toBe(1);
    expect((await book(f, 'quick', t)).ok).toBe(true);
  });

  it('moves a booking atomically; a failed move keeps the original intact', async () => {
    const f = await makeTenant({ boxes: 1 });
    const o = owner(f.ownerId);
    const a = await book(f, 'wash', await localSlot(f.tz, 2, '10:00'));
    const b = await book(f, 'wash', await localSlot(f.tz, 2, '13:00'));
    expect(a.ok && b.ok).toBe(true);

    const bad = await rpc(o, 'owner_move_booking', [f.slug, a.booking.id, await localSlot(f.tz, 2, '13:30'), null]);
    expect(bad).toMatchObject({ ok: false, code: 'slot_taken' });
    const [still] = await admin(
      `select b.starts_at, lower(o.during) lo from bookings b join resource_occupancies o on o.booking_id = b.id where b.id = $1`, [a.booking.id]);
    expect(new Date(still.starts_at).toISOString()).toBe(new Date(a.booking.starts_at).toISOString());
    expect(new Date(still.lo).toISOString()).toBe(new Date(a.booking.starts_at).toISOString());

    const target = await localSlot(f.tz, 2, '16:00');
    const ok = await rpc(o, 'owner_move_booking', [f.slug, a.booking.id, target, null]);
    expect(ok.ok).toBe(true);
    expect(new Date(ok.booking.starts_at).toISOString()).toBe(new Date(target).toISOString());
    // the old time is free again
    expect((await book(f, 'wash', await localSlot(f.tz, 2, '10:00'))).ok).toBe(true);
    // a booking can be nudged into time it already partly occupies (no self-conflict)
    const nudge = await rpc(o, 'owner_move_booking', [f.slug, a.booking.id, await localSlot(f.tz, 2, '16:30'), null]);
    expect(nudge.ok).toBe(true);
  });

  it('a cancelled booking frees its time; client cancel follows the studio policy and is idempotent', async () => {
    const f = await makeTenant({ cancelHours: 24 });
    const far = await localSlot(f.tz, 3, '11:00', 2);
    const r = await book(f, 'wash', far);
    expect((await book(f, 'wash', far)).code).toBe('slot_taken');
    const c1 = await rpc(anon(), 'cancel_my_booking', [r.access_token]);
    const c2 = await rpc(anon(), 'cancel_my_booking', [r.access_token]);
    expect(c1).toMatchObject({ ok: true, replayed: false });
    expect(c2).toMatchObject({ ok: true, replayed: true });
    expect((await book(f, 'wash', far)).ok).toBe(true);

    const g = await makeTenant({ cancelHours: 100000 % 720 });
    void g;
    const strict = await makeTenant({ cancelHours: 720 });
    const soon = await localSlot(strict.tz, 3, '11:00', 1);
    const s = await book(strict, 'wash', soon);
    expect(s.ok).toBe(true);
    const late = await rpc(anon(), 'cancel_my_booking', [s.access_token]);
    expect(late).toMatchObject({ ok: false, code: 'too_late' });
    const mine = await rpc(anon(), 'my_booking', [s.access_token]);
    expect(mine.can_cancel).toBe(false);
  });

  it('manual owner bookings obey the same occupancy rules and are idempotent', async () => {
    const f = await makeTenant({ boxes: 1 });
    const o = owner(f.ownerId);
    const t = await localSlot(f.tz, 5, '10:00');
    const key = idemKey();
    const args = [f.slug, f.services.wash, t, 'Пётр Иванов', '8 (903) 111-22-33', 'BMW X5', null, key];
    const a = await rpc(o, 'owner_create_booking', args);
    const b = await rpc(o, 'owner_create_booking', args);
    expect(a.ok).toBe(true);
    expect(b.replayed).toBe(true);
    expect(b.booking.id).toBe(a.booking.id);
    const [{ customer_phone }] = await admin(`select customer_phone from bookings where id = $1`, [a.booking.id]);
    expect(customer_phone).toBe('+79031112233');
    const clash = await rpc(o, 'owner_create_booking', [f.slug, f.services.wash, t, 'Другой', '+79990000000', '', null, idemKey()]);
    expect(clash).toMatchObject({ ok: false, code: 'slot_taken' });
  });
});
