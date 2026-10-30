/** The studio slug lives in the URL: /s/{slug}/… */
export function slugFromPath(pathname = window.location.pathname): string | null {
  const m = /^\/s\/([a-z0-9][a-z0-9-]{1,40})(?:\/|$)/.exec(pathname);
  return m ? m[1]! : null;
}

export const tokenKey = (slug: string) => `avto:${slug}:booking-token`;

export function readToken(slug: string): string | null {
  try {
    return localStorage.getItem(tokenKey(slug));
  } catch {
    return null;
  }
}
export function saveToken(slug: string, token: string) {
  try {
    localStorage.setItem(tokenKey(slug), token);
  } catch {
    /* private mode: the confirmation screen still shows the booking */
  }
}
export function clearToken(slug: string) {
  try {
    localStorage.removeItem(tokenKey(slug));
  } catch {
    /* ignore */
  }
}
