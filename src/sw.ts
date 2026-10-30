/// <reference lib="webworker" />
import { clientsClaim, setCacheNameDetails } from 'workbox-core';
import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { NetworkFirst, StaleWhileRevalidate } from 'workbox-strategies';

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<string | { url: string; revision: string | null }> };

/**
 * One worker file, one copy per studio (dist/s/<slug>/sw.js). Everything is derived from the scope it
 * was registered with, so two studios on one origin never share caches, never control each other's pages,
 * and a studio's worker never sees another studio's files.
 */
const SCOPE = new URL(self.registration.scope);
const SCOPE_PATH = SCOPE.pathname; // "/s/<slug>/"
const SLUG = SCOPE_PATH.split('/').filter(Boolean).pop() ?? 'studio';
const VERSION = 'v1';

setCacheNameDetails({ prefix: `avto-${SLUG}`, suffix: VERSION, precache: 'precache', runtime: 'runtime' });
const RUNTIME_MEDIA = `avto-${SLUG}-media-${VERSION}`;
const RUNTIME_SHELL = `avto-${SLUG}-shell-${VERSION}`;

self.skipWaiting();
clientsClaim();
cleanupOutdatedCaches();

// Build assets are listed relative to the site root; the worker lives in /s/<slug>/, so make them absolute.
precacheAndRoute(
  self.__WB_MANIFEST.map((e) => {
    const entry = typeof e === 'string' ? { url: e, revision: null } : e;
    return { url: entry.url.startsWith('/') ? entry.url : `/${entry.url}`, revision: entry.revision };
  }),
);

/**
 * Only public, studio-owned static content is ever cached: the app shell (navigations inside this scope),
 * the web manifest, and this studio's media. API traffic (rest, auth, functions, storage) and anything
 * with credentials is never touched, so no private data can end up in a cache.
 */
const NEVER = /^\/(rest|auth|functions|realtime|storage)\//;

registerRoute(
  ({ request, url }) => request.mode === 'navigate' && url.origin === SCOPE.origin && url.pathname.startsWith(SCOPE_PATH) && !NEVER.test(url.pathname),
  new NetworkFirst({ cacheName: RUNTIME_SHELL, networkTimeoutSeconds: 4, matchOptions: { ignoreSearch: true } }),
);
registerRoute(
  ({ url }) => url.origin === SCOPE.origin && url.pathname.startsWith(`${SCOPE_PATH}media/`),
  new StaleWhileRevalidate({ cacheName: RUNTIME_MEDIA }),
);
registerRoute(
  ({ url }) => url.origin === SCOPE.origin && url.pathname === `${SCOPE_PATH}manifest.webmanifest`,
  new StaleWhileRevalidate({ cacheName: RUNTIME_SHELL }),
);

// Offline navigation: serve the studio shell that was cached on a previous visit.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.mode !== 'navigate') return;
  const url = new URL(req.url);
  if (url.origin !== SCOPE.origin || !url.pathname.startsWith(SCOPE_PATH)) return;
  // NetworkFirst above handles the happy path; this is the offline fallback.
  event.respondWith(
    (async () => {
      try {
        return await fetch(req);
      } catch {
        const cache = await caches.open(RUNTIME_SHELL);
        return (await cache.match(`${SCOPE_PATH}index.html`)) ?? (await cache.match(req, { ignoreSearch: true })) ?? Response.error();
      }
    })(),
  );
});

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(RUNTIME_SHELL).then((c) => c.add(`${SCOPE_PATH}index.html`).catch(() => undefined)));
});

self.addEventListener('activate', (event) => {
  // Remove caches of older versions of THIS studio only.
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n.startsWith(`avto-${SLUG}-`) && !n.includes(`-${VERSION}`)).map((n) => caches.delete(n))),
    ),
  );
});

// Sign-out hook: the page asks the worker to drop runtime caches. Nothing private is cached, this is belt and braces.
self.addEventListener('message', (event) => {
  if (event.data?.type === 'CLEAR_RUNTIME') {
    event.waitUntil(Promise.all([caches.delete(RUNTIME_MEDIA), caches.delete(RUNTIME_SHELL)]));
  }
});

// ---------------------------------------------------------------- push
type PushPayload = { title: string; body: string; url: string; tag?: string };

self.addEventListener('push', (event) => {
  let data: PushPayload | null = null;
  try {
    data = event.data ? (event.data.json() as PushPayload) : null;
  } catch {
    data = null;
  }
  if (!data?.title) return;
  const target = typeof data.url === 'string' && data.url.startsWith(SCOPE_PATH) ? data.url : SCOPE_PATH;
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      tag: data.tag,
      icon: `${SCOPE_PATH}icons/icon-192.png`,
      badge: `${SCOPE_PATH}icons/icon-192.png`,
      data: { url: target },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL((event.notification.data as { url?: string } | undefined)?.url ?? SCOPE_PATH, SCOPE.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (list) => {
      for (const c of list) {
        if (c.url.startsWith(SCOPE.href) && 'focus' in c) {
          await c.focus();
          if ('navigate' in c) await (c as WindowClient).navigate(url).catch(() => undefined);
          return;
        }
      }
      await self.clients.openWindow(url);
    }),
  );
});
