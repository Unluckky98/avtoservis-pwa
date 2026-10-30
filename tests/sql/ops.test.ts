import { describe, expect, it } from 'vitest';
import { admin, anon, book, localSlot, makeTenant, owner, rpc, service, idemKey } from './helpers';

const sub = (n = 1) => ['https://push.example/' + Math.random().toString(36).slice(2), 'p256dh-' + n, 'auth-' + n];

describe('shared atomic counters', () => {
  it('rate limiter admits exactly the limit under heavy concurrency', async () => {
    const bucket = 'conc-' + Math.random();
    const res = await Promise.all(Array.from({ length: 40 }, () => rpc(service, 'rate_hit', [bucket, 5, 3600])));
    expect(res.filter(Boolean)).toHaveLength(5);
    const [{ hits }] = await admin(`select hits from rate_limits where bucket = $1`, [bucket]);
    expect(hits).toBe(40);
  });

  it('LLM budget never lets concurrent calls overshoot the daily limit', async () => {
    const f = await makeTenant();
    const res = await Promise.all(Array.from({ length: 25 }, () => rpc(service, 'llm_reserve', [f.id, 3, 1_000_000])));
    expect(res.filter(Boolean)).toHaveLength(3);
    await rpc(service, 'llm_add_tokens', [f.id, 5000]);
    const [row] = await admin(`select calls, tokens::int from llm_usage where tenant_id = $1`, [f.id]);
    expect(row).toMatchObject({ calls: 3, tokens: 5000 });
    // token budget also stops further calls
    const g = await makeTenant();
    expect(await rpc(service, 'llm_reserve', [g.id, 100, 1000])).toBe(true);
    await rpc(service, 'llm_add_tokens', [g.id, 1500]);
    expect(await rpc(service, 'llm_reserve', [g.id, 100, 1000])).toBe(false);
  });
});

describe('reminder outbox', () => {
  async function liveBooking() {
    const f = await makeTenant({ boxes: 2 });
    const r = await book(f, 'wash', await localSlot(f.tz, 3, '12:00', 2));
    return { f, r };
  }

  it('creates exactly one deduplicated job per booking', async () => {
    const { f, r } = await liveBooking();
    const [ep, k1, k2] = sub();
    const a = await rpc(anon(), 'enable_reminder', [r.access_token, ep, k1, k2]);
    const b = await rpc(anon(), 'enable_reminder', [r.access_token, ep, k1, k2]);
    const c = await rpc(anon(), 'enable_reminder', [r.access_token, sub(2)[0], k1, k2]);
    expect(a).toMatchObject({ ok: true, enabled: true });
    expect(b.enabled).toBe(true);
    expect(c.enabled).toBe(true);
    const jobs = await admin(`select * from notification_jobs where booking_id = $1`, [r.booking.id]);
    expect(jobs).toHaveLength(1);
    const diff = new Date(r.booking.starts_at).getTime() - new Date(jobs[0].run_at).getTime();
    expect(diff).toBe(24 * 3600_000);
    const subs = await admin(`select count(*)::int n from push_subscriptions where booking_id = $1`, [r.booking.id]);
    expect(subs[0].n).toBe(2);
    void f;
  });

  it('preview studios never create real jobs; too-soon bookings are honest about it', async () => {
    const p = await makeTenant({ status: 'preview' });
    const rp = await book(p, 'wash', await localSlot(p.tz, 3, '12:00', 2));
    const res = await rpc(anon(), 'enable_reminder', [rp.access_token, ...sub()]);
    expect(res).toMatchObject({ ok: true, enabled: false, reason: 'preview' });
    expect((await admin(`select count(*)::int n from notification_jobs where tenant_id = $1`, [p.id]))[0].n).toBe(0);

    const f = await makeTenant();
    const soon = new Date(Date.now() + 2 * 3600_000).toISOString();
    const m = await rpc(owner(f.ownerId), 'owner_create_booking', [f.slug, f.services.quick, soon, 'Срочный', '+79005550000', '', null, idemKey()]);
    expect(m.ok).toBe(true);
    // owner-created bookings have no client token; use a client booking close to now via direct row
    const [{ id }] = await admin(`select id from bookings where tenant_id = $1`, [f.id]);
    await admin(`update bookings set access_token_hash = extensions.digest(repeat('x', 64), 'sha256') where id = $1`, [id]);
    const tooSoon = await rpc(anon(), 'enable_reminder', ['x'.repeat(64), ...sub()]);
    expect(tooSoon).toMatchObject({ ok: true, enabled: false, reason: 'too_soon' });
  });

  it('two dispatchers claiming at once never get the same job; leases expire and retries are bounded', async () => {
    const { r } = await liveBooking();
    await rpc(anon(), 'enable_reminder', [r.access_token, ...sub()]);
    await admin(`update notification_jobs set run_at = now() - interval '1 minute' where booking_id = $1`, [r.booking.id]);

    const claims = await Promise.all(Array.from({ length: 6 }, () => rpc(service, 'claim_notification_jobs', [50, 120])));
    const mine = claims.flat().filter((j: any) => j.booking.id === r.booking.id);
    expect(mine).toHaveLength(1);
    expect(mine[0].subscriptions).toHaveLength(1);
    expect(mine[0].attempts).toBe(1);

    // while leased, nobody else gets it
    expect((await rpc(service, 'claim_notification_jobs', [50, 120])).filter((j: any) => j.booking.id === r.booking.id)).toHaveLength(0);

    // a crashed dispatcher: lease expires, job is claimable again
    await admin(`update notification_jobs set lease_until = now() - interval '1 second' where booking_id = $1`, [r.booking.id]);
    const again = (await rpc(service, 'claim_notification_jobs', [50, 120])).find((j: any) => j.booking.id === r.booking.id);
    expect(again.attempts).toBe(2);

    // failure: retried later, and abandoned after 5 attempts
    await rpc(service, 'complete_notification_job', [again.job_id, false, 'push 503', 60]);
    const [pending] = await admin(`select status, run_at > now() later from notification_jobs where id = $1`, [again.job_id]);
    expect(pending).toMatchObject({ status: 'pending', later: true });
    await admin(`update notification_jobs set attempts = 5, status = 'leased', lease_until = now() + interval '1 minute' where id = $1`, [again.job_id]);
    await rpc(service, 'complete_notification_job', [again.job_id, false, 'push 503', 60]);
    expect((await admin(`select status from notification_jobs where id = $1`, [again.job_id]))[0].status).toBe('failed');
  });

  it('success marks the job sent and it is never claimed again', async () => {
    const { r } = await liveBooking();
    await rpc(anon(), 'enable_reminder', [r.access_token, ...sub()]);
    await admin(`update notification_jobs set run_at = now() - interval '1 minute' where booking_id = $1`, [r.booking.id]);
    const job = (await rpc(service, 'claim_notification_jobs', [50, 60])).find((j: any) => j.booking.id === r.booking.id);
    await rpc(service, 'complete_notification_job', [job.job_id, true, null, 60]);
    expect((await admin(`select status from notification_jobs where id = $1`, [job.job_id]))[0].status).toBe('sent');
    expect((await rpc(service, 'claim_notification_jobs', [50, 60])).filter((j: any) => j.booking.id === r.booking.id)).toHaveLength(0);
  });

  it('cancelling cancels the job; moving reschedules it; done stops it', async () => {
    const f = await makeTenant({ boxes: 2 });
    const o = owner(f.ownerId);
    const a = await book(f, 'wash', await localSlot(f.tz, 3, '12:00', 2));
    const b = await book(f, 'wash', await localSlot(f.tz, 4, '12:00', 2));
    const c = await book(f, 'wash', await localSlot(f.tz, 5, '12:00', 2));
    for (const x of [a, b, c]) await rpc(anon(), 'enable_reminder', [x.access_token, ...sub()]);

    await rpc(anon(), 'cancel_my_booking', [a.access_token]);
    expect((await admin(`select status from notification_jobs where booking_id = $1`, [a.booking.id]))[0].status).toBe('cancelled');

    const newStart = await localSlot(f.tz, 4, '16:00', 2);
    await rpc(o, 'owner_move_booking', [f.slug, b.booking.id, newStart, null]);
    const [jb] = await admin(`select status, run_at from notification_jobs where booking_id = $1`, [b.booking.id]);
    expect(jb.status).toBe('pending');
    expect(new Date(newStart).getTime() - new Date(jb.run_at).getTime()).toBe(24 * 3600_000);

    await rpc(o, 'owner_set_status', [f.slug, c.booking.id, 'done']);
    expect((await admin(`select status from notification_jobs where booking_id = $1`, [c.booking.id]))[0].status).toBe('cancelled');

    // cancelled/done bookings are never dispatched, even if a stale job row said pending
    await admin(`update notification_jobs set status = 'pending', run_at = now() - interval '1 minute' where booking_id = any($1)`, [[a.booking.id, c.booking.id]]);
    const claimed = (await rpc(service, 'claim_notification_jobs', [100, 60])).map((j: any) => j.booking.id);
    expect(claimed).not.toContain(a.booking.id);
    expect(claimed).not.toContain(c.booking.id);
  });

  it('jobs of preview studios are never dispatched', async () => {
    const p = await makeTenant({ status: 'preview' });
    const r = await book(p, 'wash', await localSlot(p.tz, 3, '12:00', 2));
    await admin(`insert into notification_jobs (tenant_id, booking_id, run_at, dedupe_key) values ($1, $2, now() - interval '1 hour', $3)`,
      [p.id, r.booking.id, r.booking.id + ':reminder_24h']);
    const claimed = (await rpc(service, 'claim_notification_jobs', [100, 60])).map((j: any) => j.booking.id);
    expect(claimed).not.toContain(r.booking.id);
  });
});
