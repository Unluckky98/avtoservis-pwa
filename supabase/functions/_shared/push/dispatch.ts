// Outbox dispatcher core. Pure logic with injected I/O so it can be tested against the real database
// with a fake push sender, and run in Deno with the real one.

export type Subscription = { endpoint: string; p256dh: string; auth: string };
export type Job = {
  job_id: string;
  kind: string;
  attempts: number;
  booking: { id: string; service_name: string; starts_at: string };
  studio: { slug: string; name: string; address: string | null; timezone: string };
  subscriptions: Subscription[];
};
export type SendResult = { ok: true } | { ok: false; gone: boolean; error: string };
export type Payload = { title: string; body: string; url: string; tag: string };

export type DispatchDeps = {
  claim(limit: number, leaseSeconds: number): Promise<Job[]>;
  complete(jobId: string, ok: boolean, error: string | null, retryInSeconds: number): Promise<void>;
  dropSubscription(endpoint: string): Promise<void>;
  send(sub: Subscription, payload: Payload): Promise<SendResult>;
};

export function buildPayload(job: Job): Payload {
  const when = new Intl.DateTimeFormat('ru-RU', { timeZone: job.studio.timezone, weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(job.booking.starts_at));
  return {
    title: `Напоминание о записи: ${job.booking.service_name}`,
    body: `${when} · ${job.studio.name}${job.studio.address ? `, ${job.studio.address}` : ''}`,
    url: `/s/${job.studio.slug}/my`,
    tag: `booking-${job.booking.id}`,
  };
}

export type Summary = { claimed: number; sent: number; retried: number; failed: number; dropped: number };

/** Backoff grows with attempts: 5 min, 10, 20, 40 (the database stops after 5 attempts). */
export const retryDelay = (attempts: number) => Math.min(300 * 2 ** Math.max(attempts - 1, 0), 3600);

export async function dispatchBatch(d: DispatchDeps, opts: { limit?: number; leaseSeconds?: number } = {}): Promise<Summary> {
  const jobs = await d.claim(opts.limit ?? 20, opts.leaseSeconds ?? 120);
  const s: Summary = { claimed: jobs.length, sent: 0, retried: 0, failed: 0, dropped: 0 };
  for (const job of jobs) {
    if (job.subscriptions.length === 0) {
      // Nobody to notify (subscription removed): finish the job instead of retrying forever.
      await d.complete(job.job_id, true, 'no_subscriptions', 0);
      s.sent += 0;
      continue;
    }
    const payload = buildPayload(job);
    let delivered = false;
    let lastError = '';
    let allGone = true;
    for (const sub of job.subscriptions) {
      let r: SendResult;
      try {
        r = await d.send(sub, payload);
      } catch (e) {
        r = { ok: false, gone: false, error: e instanceof Error ? e.message : 'send_failed' };
      }
      if (r.ok) {
        delivered = true;
        allGone = false;
      } else if (r.gone) {
        await d.dropSubscription(sub.endpoint);
        s.dropped++;
      } else {
        allGone = false;
        lastError = r.error;
      }
    }
    if (delivered) {
      await d.complete(job.job_id, true, null, 0);
      s.sent++;
    } else if (allGone) {
      await d.complete(job.job_id, true, 'subscriptions_gone', 0);
    } else {
      await d.complete(job.job_id, false, lastError, retryDelay(job.attempts));
      s.retried++;
      if (job.attempts >= 5) s.failed++;
    }
  }
  return s;
}
