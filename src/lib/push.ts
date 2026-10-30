import { enableReminder } from './api';

export type PushSupport = 'ok' | 'no-sw' | 'no-push' | 'no-key' | 'denied';

export function pushSupport(): PushSupport {
  if (!('serviceWorker' in navigator)) return 'no-sw';
  if (!('PushManager' in window) || !('Notification' in window)) return 'no-push';
  if (!import.meta.env.VITE_VAPID_PUBLIC_KEY) return 'no-key';
  if (Notification.permission === 'denied') return 'denied';
  return 'ok';
}

function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
const toB64 = (buf: ArrayBuffer | null) => (buf ? btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : '');

/** Asks permission, subscribes and tells the server. Returns what really happened. */
export async function turnOnReminder(token: string): Promise<{ state: 'enabled' | 'preview' | 'too_soon' | 'denied' | 'unsupported'; message: string }> {
  const sup = pushSupport();
  if (sup !== 'ok') {
    const msg: Record<Exclude<PushSupport, 'ok'>, string> = {
      'no-sw': 'Этот браузер не поддерживает уведомления.',
      'no-push': 'Этот браузер не поддерживает push-уведомления. На iPhone добавьте сайт на экран «Домой».',
      'no-key': 'Напоминания в этой установке не настроены.',
      denied: 'Уведомления заблокированы в настройках браузера.',
    };
    return { state: sup === 'denied' ? 'denied' : 'unsupported', message: msg[sup] };
  }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return { state: 'denied', message: 'Без разрешения напоминание прислать не получится.' };
  const reg = await navigator.serviceWorker.ready;
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(import.meta.env.VITE_VAPID_PUBLIC_KEY!) }));
  const r = await enableReminder(token, { endpoint: sub.endpoint, p256dh: toB64(sub.getKey('p256dh')), auth: toB64(sub.getKey('auth')) });
  if (r.enabled) return { state: 'enabled', message: 'Напомним за сутки до записи.' };
  if (r.reason === 'preview') return { state: 'preview', message: 'Это образец студии: настоящие уведомления здесь не отправляются.' };
  return { state: 'too_soon', message: 'До записи меньше суток — напоминание не нужно.' };
}
