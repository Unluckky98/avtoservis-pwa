/** Registers this studio's own worker (/s/<slug>/sw.js, scope /s/<slug>/). Production builds only. */
export function registerStudioWorker(slug: string) {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register(`/s/${slug}/sw.js`, { scope: `/s/${slug}/` }).catch(() => {
      /* the app works without a worker; installability and offline shell are just unavailable */
    });
  });
}

/** Called on owner sign-out. */
export async function clearRuntimeCaches() {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    reg?.active?.postMessage({ type: 'CLEAR_RUNTIME' });
  } catch {
    /* ignore */
  }
}
