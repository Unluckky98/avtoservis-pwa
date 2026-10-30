// Supabase Edge Function (Deno). Called every minute by Supabase Cron (see SETUP.md).
// Secrets: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto:…), DISPATCH_SECRET.
import { createClient } from '@supabase/supabase-js';
import webpush from 'web-push';
import { dispatchBatch, type Job } from '../_shared/push/dispatch.ts';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

Deno.serve(async (req) => {
  const secret = Deno.env.get('DISPATCH_SECRET');
  if (!secret || !safeEqual(req.headers.get('x-dispatch-secret') ?? '', secret)) return json(401, { error: 'unauthorized' });
  const pub = Deno.env.get('VAPID_PUBLIC_KEY');
  const priv = Deno.env.get('VAPID_PRIVATE_KEY');
  const subject = Deno.env.get('VAPID_SUBJECT');
  if (!pub || !priv || !subject) return json(503, { error: 'vapid_not_configured' });
  webpush.setVapidDetails(subject, pub, priv);

  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const summary = await dispatchBatch({
    claim: async (limit, lease) => {
      const { data, error } = await db.rpc('claim_notification_jobs', { p_limit: limit, p_lease_seconds: lease });
      if (error) throw new Error(error.message);
      return data as Job[];
    },
    complete: async (id, ok, err, retry) => void (await db.rpc('complete_notification_job', { p_job: id, p_ok: ok, p_error: err, p_retry_in_seconds: retry })),
    dropSubscription: async (endpoint) => void (await db.from('push_subscriptions').delete().eq('endpoint', endpoint)),
    send: async (sub, payload) => {
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(payload), { TTL: 6 * 3600 });
        return { ok: true };
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode;
        return { ok: false, gone: status === 404 || status === 410, error: `push_${status ?? 'error'}` };
      }
    },
  });
  return json(200, summary);
});
