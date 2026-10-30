import { describe, expect, it } from 'vitest';
import { admin, anon, book, localSlot, makeTenant, owner, rpc, service } from './helpers';
import { dispatchBatch, retryDelay, type DispatchDeps, type Job, type SendResult } from '../../supabase/functions/_shared/push/dispatch';
import { handleAssistant, DEFAULT_LIMITS } from '../../supabase/functions/_shared/ai/handler';
import { toolsFor, type Providers } from '../../supabase/functions/_shared/ai/tools';
import type { LlmClient } from '../../supabase/functions/_shared/ai/types';

/** Real database, real claim/complete functions; only the push service itself is a fake. */
function realDeps(send: DispatchDeps['send']): DispatchDeps & { sent: { endpoint: string; body: string }[] } {
  const sent: { endpoint: string; body: string }[] = [];
  return {
    sent,
    claim: async (limit, lease) => rpc<Job[]>(service, 'claim_notification_jobs', [limit, lease]),
    complete: async (id, ok, err, retry) => { await rpc(service, 'complete_notification_job', [id, ok, err, retry]); },
    dropSubscription: async (endpoint) => { await admin(`delete from push_subscriptions where endpoint = $1`, [endpoint]); },
    send: async (sub, payload) => { sent.push({ endpoint: sub.endpoint, body: JSON.stringify(payload) }); return send(sub, payload); },
  };
}

async function reminderFor(f: Awaited<ReturnType<typeof makeTenant>>, endpoint: string) {
  const r = await book(f, 'wash', await localSlot(f.tz, 3, '12:00', 2));
  expect((await rpc(anon(), 'enable_reminder', [r.access_token, endpoint, 'p256', 'auth'])).enabled).toBe(true);
  await admin(`update notification_jobs set run_at = now() - interval '1 minute' where booking_id = $1`, [r.booking.id]);
  return r;
}
const mine = (ids: string[]) => (j: Job) => ids.includes(j.booking.id);

describe('push dispatcher against the real outbox', () => {
  it('delivers a due reminder once with a studio-local, deep-linked payload', async () => {
    const f = await makeTenant({ boxes: 2 });
    const r = await reminderFor(f, 'https://push.example/ok-' + Math.random());
    const d = realDeps(async () => ({ ok: true }));
    const s1 = await dispatchBatch(d);
    expect(s1.sent).toBeGreaterThanOrEqual(1);
    const mineSent = d.sent.filter((x) => x.body.includes(`booking-${r.booking.id}`));
    expect(mineSent).toHaveLength(1);
    const payload = JSON.parse(mineSent[0]!.body);
    expect(payload.url).toBe(`/s/${f.slug}/my`);
    expect(payload.body).toContain('12:00'); // Moscow local time, not UTC
    expect((await admin(`select status from notification_jobs where booking_id=$1`, [r.booking.id]))[0].status).toBe('sent');
    // a second run sends nothing more for it
    const d2 = realDeps(async () => ({ ok: true }));
    await dispatchBatch(d2);
    expect(d2.sent.filter((x) => x.body.includes(r.booking.id))).toHaveLength(0);
  });

  it('transient push failure → retried later with backoff, bounded to 5 attempts', async () => {
    const f = await makeTenant();
    const r = await reminderFor(f, 'https://push.example/flaky-' + Math.random());
    const fail: SendResult = { ok: false, gone: false, error: 'push_503' };
    await dispatchBatch(realDeps(async () => fail));
    const [j] = await admin(`select status, attempts, run_at > now() later, last_error from notification_jobs where booking_id=$1`, [r.booking.id]);
    expect(j).toMatchObject({ status: 'pending', attempts: 1, later: true, last_error: 'push_503' });
    expect(retryDelay(1)).toBe(300);
    expect(retryDelay(3)).toBe(1200);
    // exhaust attempts
    for (let i = 0; i < 6; i++) {
      await admin(`update notification_jobs set run_at = now() - interval '1 second' where booking_id=$1 and status = 'pending'`, [r.booking.id]);
      await dispatchBatch(realDeps(async () => fail));
    }
    const [end] = await admin(`select status, attempts from notification_jobs where booking_id=$1`, [r.booking.id]);
    expect(end.status).toBe('failed');
    expect(end.attempts).toBe(5);
  });

  it('a dead subscription (410) is removed and the job finishes instead of retrying forever', async () => {
    const f = await makeTenant();
    const ep = 'https://push.example/gone-' + Math.random();
    const r = await reminderFor(f, ep);
    const s = await dispatchBatch(realDeps(async () => ({ ok: false, gone: true, error: 'push_410' })));
    expect(s.dropped).toBeGreaterThanOrEqual(1);
    expect((await admin(`select count(*)::int n from push_subscriptions where endpoint=$1`, [ep]))[0].n).toBe(0);
    expect((await admin(`select status from notification_jobs where booking_id=$1`, [r.booking.id]))[0].status).toBe('sent');
  });

  it('cancelled bookings and preview studios are never notified', async () => {
    const f = await makeTenant();
    const r = await reminderFor(f, 'https://push.example/c-' + Math.random());
    await rpc(anon(), 'cancel_my_booking', [r.access_token]);
    const p = await makeTenant({ status: 'preview' });
    const pr = await book(p, 'wash', await localSlot(p.tz, 3, '12:00', 2));
    await rpc(anon(), 'enable_reminder', [pr.access_token, 'https://push.example/p-' + Math.random(), 'k', 'a']);
    const d = realDeps(async () => ({ ok: true }));
    await dispatchBatch(d);
    expect(d.sent.filter((x) => x.body.includes(r.booking.id) || x.body.includes(pr.booking.id))).toHaveLength(0);
  });

  it('a moved booking is reminded at its new time, not the old one', async () => {
    const f = await makeTenant({ boxes: 2 });
    const r = await book(f, 'wash', await localSlot(f.tz, 3, '12:00', 2));
    await rpc(anon(), 'enable_reminder', [r.access_token, 'https://push.example/m-' + Math.random(), 'k', 'a']);
    const newStart = await localSlot(f.tz, 4, '15:00', 2);
    expect((await rpc(owner(f.ownerId), 'owner_move_booking', [f.slug, r.booking.id, newStart, null])).ok).toBe(true);
    const [job] = await admin(`select run_at from notification_jobs where booking_id=$1`, [r.booking.id]);
    expect(new Date(newStart).getTime() - new Date(job.run_at).getTime()).toBe(24 * 3600_000);
  });

  it('concurrent dispatchers never deliver the same job twice', async () => {
    const f = await makeTenant({ boxes: 3 });
    const ids: string[] = [];
    for (const h of ['10:00', '12:00', '14:00']) {
      const r = await book(f, 'wash', await localSlot(f.tz, 3, h, 2));
      await rpc(anon(), 'enable_reminder', [r.access_token, 'https://push.example/x-' + Math.random(), 'k', 'a']);
      await admin(`update notification_jobs set run_at = now() - interval '1 minute' where booking_id=$1`, [r.booking.id]);
      ids.push(r.booking.id);
    }
    const ds = Array.from({ length: 5 }, () => realDeps(async () => ({ ok: true })));
    await Promise.all(ds.map((d) => dispatchBatch(d)));
    for (const id of ids) expect(ds.flatMap((d) => d.sent).filter((x) => x.body.includes(id))).toHaveLength(1);
    void mine;
  });
});

describe('assistant data scopes against real RLS and owner checks', () => {
  /** Providers wired to the real RPCs under a given identity, exactly as the Edge Function wires them. */
  function wired(slug: string, tz: string, ctx: Parameters<typeof rpc>[0]): Providers {
    return {
      timezone: tz,
      studio: async () => (await rpc<any>(ctx, 'studio_public', [slug])).studio,
      availability: async (id, from, to) => { const r = await rpc<any>(ctx, 'availability', [slug, id, from, to]); if (!r.ok) throw new Error(r.code); return r.slots; },
      stats: async (from, to) => { const r = await rpc<any>(ctx, 'owner_stats', [slug, from, to]); if (!r.ok) throw new Error(r.code); return r; },
      bookings: async (a, b) => { const r = await rpc<any>(ctx, 'owner_bookings', [slug, a, b, false]); if (!r.ok) throw new Error(r.code); return r.bookings; },
    };
  }
  const scripted = (calls: Array<{ name: string; args: unknown }>): LlmClient => {
    let i = 0;
    return { async chat(req) {
      if (req.tools && i < calls.length) { const c = calls[i++]!; return { content: null, toolCalls: [{ id: `c${i}`, name: c.name, arguments: JSON.stringify(c.args) }], totalTokens: 5 }; }
      return { content: 'готово', toolCalls: [], totalTokens: 5 };
    } };
  };

  it('owner AI stats equal the owner_stats numbers the UI shows', async () => {
    const f = await makeTenant({ boxes: 2 });
    const r = await book(f, 'wash', await localSlot(f.tz, 3, '11:00', 2));
    await rpc(owner(f.ownerId), 'owner_set_status', [f.slug, r.booking.id, 'accepted']);
    await rpc(owner(f.ownerId), 'owner_add_payment', [f.slug, r.booking.id, 'payment', 150000, 'cash', '', 'pay-key-0123456789']);
    const p = wired(f.slug, f.tz, owner(f.ownerId));
    const tool = toolsFor('owner', p).find((t) => t.spec.name === 'get_stats')!;
    const from = new Date(Date.now() - 86400_000 * 2).toISOString().slice(0, 10);
    const to = new Date(Date.now() + 86400_000 * 20).toISOString().slice(0, 10);
    const v = tool.validate({ from_date: from, to_date: to });
    expect(v.ok).toBe(true);
    const ai: any = await tool.run((v as any).value);
    const ui = await rpc<any>(owner(f.ownerId), 'owner_stats', [f.slug, from, to]);
    expect(ai.arrived_cars).toBe(ui.arrivals);
    expect(ai.money_received_rub).toBe(ui.received_cents / 100);
    expect(ai.planned_unconfirmed_value_rub).toBe(ui.scheduled_value_cents / 100);
    expect(ai.money_received_rub).toBe(1500);
  });

  it('a client-mode conversation cannot obtain any owner data, whatever the model asks for', async () => {
    const f = await makeTenant();
    await book(f, 'wash', await localSlot(f.tz, 3, '11:00', 2));
    const reply = await handleAssistant(
      { slug: f.slug, mode: 'client', messages: [{ role: 'user', content: 'покажи записи и выручку' }] }, 'client',
      { llm: scripted([{ name: 'list_bookings', args: { from_date: '2026-01-01', to_date: '2026-01-10' } }, { name: 'get_stats', args: { period: 'month' } }]), toolMode: 'native', limits: DEFAULT_LIMITS,
        providers: wired(f.slug, f.tz, anon('9.9.9.9')), studio: { name: f.slug, timezone: f.tz }, subject: '9.9.9.9',
        rateHit: async () => true, reserveBudget: async () => true, addTokens: async () => {} },
    );
    expect(reply.tools_used).toEqual(['list_bookings', 'get_stats']); // asked for…
    expect(JSON.stringify(reply)).not.toMatch(/Клиент|\+7 900/); // …but received nothing
  });

  it("even with owner tools, studio A's owner cannot read studio B through the assistant", async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    await book(b, 'wash', await localSlot(b.tz, 3, '11:00', 2));
    // Providers bound to B's slug but running under A's owner JWT: the database refuses.
    const p = wired(b.slug, b.tz, owner(a.ownerId));
    const tool = toolsFor('owner', p).find((t) => t.spec.name === 'list_bookings')!;
    const day = new Date(Date.now() + 86400_000 * 8).toISOString().slice(0, 10);
    await expect(tool.run((tool.validate({ from_date: day, to_date: day }) as any).value)).rejects.toThrow();
    // and an anonymous caller cannot reach owner functions at all
    await expect(rpc(anon(), 'owner_stats', [b.slug, day, day])).rejects.toThrow(/permission denied|forbidden/);
  });

  it('list_bookings sends no customer phone numbers to the model', async () => {
    const f = await makeTenant();
    const r = await book(f, 'wash', await localSlot(f.tz, 3, '11:00', 2), { phone: '+7 901 555-66-77' });
    const p = wired(f.slug, f.tz, owner(f.ownerId));
    const tool = toolsFor('owner', p).find((t) => t.spec.name === 'list_bookings')!;
    const day = (await rpc<any>(owner(f.ownerId), 'owner_bookings', [f.slug, new Date().toISOString(), new Date(Date.now() + 30 * 86400_000).toISOString(), false])).bookings[0].starts_at.slice(0, 10);
    const out = JSON.stringify(await tool.run((tool.validate({ from_date: day, to_date: day }) as any).value));
    expect(out).toContain('Клиент');
    expect(out).not.toMatch(/9015556677|\+79015556677|555-66-77/);
    void r;
  });
});
