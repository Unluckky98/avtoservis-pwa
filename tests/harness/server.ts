import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import pg from 'pg';
import { DEFAULT_LIMITS, handleAssistant } from '../../supabase/functions/_shared/ai/handler';
import { AssistantError } from '../../supabase/functions/_shared/ai/types';
import type { Providers } from '../../supabase/functions/_shared/ai/tools';
import { harnessLlm } from './fake-llm';

/**
 * TEST HARNESS — NOT the Supabase API.
 * It serves the built static app and answers the same HTTP calls supabase-js makes
 * (POST /rest/v1/rpc/<fn>, a few table reads, password sign-in) by running them against
 * REAL PostgreSQL with the real migrations, switching to the anon/authenticated role and
 * setting request.jwt.claims exactly like PostgREST does. GoTrue, PostgREST and Storage
 * themselves are NOT exercised here; see ACCEPTANCE.md.
 */
export const ANON_KEY = 'harness-anon-key';
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

type Claims = { role: 'anon' | 'authenticated'; sub: string | null };

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
export const fakeJwt = (sub: string) => `${b64({ alg: 'none' })}.${b64({ sub, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}.harness`;

function claimsOf(req: IncomingMessage): Claims {
  const auth = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
  if (!auth || auth === ANON_KEY) return { role: 'anon', sub: null };
  try {
    const p = JSON.parse(Buffer.from(auth.split('.')[1] ?? '', 'base64url').toString());
    if (p.sub) return { role: 'authenticated', sub: p.sub };
  } catch { /* fall through */ }
  return { role: 'anon', sub: null };
}

async function body(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

export type HarnessUser = { id: string; password: string };

export async function startHarness(opts: { dbUrl: string; distDir: string; port?: number; users?: Record<string, HarnessUser>; storageDir?: string }): Promise<{ url: string; server: Server; pool: pg.Pool; close(): Promise<void> }> {
  const pool = new pg.Pool({ connectionString: opts.dbUrl, max: 10 });
  const ident = /^[a-z_][a-z0-9_]*$/;

  async function asRole<T>(c: Claims, fn: (q: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(`set local role ${c.role}`);
      await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: c.sub, role: c.role })]);
      const out = await fn(client);
      await client.query('commit');
      return out;
    } catch (e) {
      await client.query('rollback').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      const path = url.pathname;

      // ---- PostgREST-style rpc
      const rpc = /^\/rest\/v1\/rpc\/([a-z_]+)$/.exec(path);
      if (rpc && req.method === 'POST') {
        const fn = rpc[1]!;
        const args = await body(req);
        const keys = Object.keys(args);
        if (!ident.test(fn) || !keys.every((k) => ident.test(k))) return json(res, 400, { message: 'bad name' });
        const text = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`;
        try {
          const rows = await asRole(claimsOf(req), (q) => q.query(text, keys.map((k) => (typeof args[k] === 'object' && args[k] !== null ? JSON.stringify(args[k]) : args[k]))));
          return json(res, 200, rows.rows[0]?.r ?? null);
        } catch (e: any) {
          const status = e.code === '42501' ? 403 : 400;
          return json(res, status, { code: e.code, message: e.message });
        }
      }

      // ---- PostgREST-style table access (RLS and GRANTs apply: the query runs as the caller's role)
      const tbl = /^\/rest\/v1\/([a-z_]+)$/.exec(path);
      if (tbl) {
        const t = tbl[1]!;
        if (!ident.test(t)) return json(res, 400, { message: 'bad table' });
        const eq: string[] = [];
        const vals: unknown[] = [];
        for (const [k, v] of url.searchParams) {
          const m = /^eq\.(.*)$/.exec(v);
          if (m && ident.test(k)) { vals.push(m[1]); eq.push(`${k} = $${vals.length}`); }
        }
        const where = eq.length ? ' where ' + eq.join(' and ') : '';
        const wantsRows = /return=representation/.test(String(req.headers.prefer ?? ''));
        const c = claimsOf(req);
        try {
          if (req.method === 'GET') {
            const rows = await asRole(c, (q) => q.query(`select * from public.${t}${where}`, vals));
            return json(res, 200, rows.rows);
          }
          if (req.method === 'POST') {
            const b = await body(req);
            const list: Record<string, unknown>[] = Array.isArray(b) ? b : [b];
            const cols = [...new Set(list.flatMap((r) => Object.keys(r)))];
            if (!cols.every((k) => ident.test(k)) || list.length === 0) return json(res, 400, { message: 'bad body' });
            const params: unknown[] = [];
            const tuples = list.map((r) => `(${cols.map((k) => { params.push(r[k] ?? null); return `$${params.length}`; }).join(', ')})`);
            const conflict = (url.searchParams.get('on_conflict') ?? '').split(',').filter(Boolean);
            const merge = /merge-duplicates/.test(String(req.headers.prefer ?? ''));
            const up = merge && conflict.length && conflict.every((k) => ident.test(k))
              ? ` on conflict (${conflict.join(', ')}) do update set ${cols.filter((k) => !conflict.includes(k)).map((k) => `${k} = excluded.${k}`).join(', ')}` : '';
            const rows = await asRole(c, (q) => q.query(`insert into public.${t} (${cols.join(', ')}) values ${tuples.join(', ')}${up} returning *`, params));
            return wantsRows ? json(res, 201, rows.rows) : (res.writeHead(201), res.end());
          }
          if (req.method === 'PATCH') {
            const b = await body(req);
            const cols = Object.keys(b);
            if (!cols.length || !cols.every((k) => ident.test(k)) || !eq.length) return json(res, 400, { message: 'bad body' });
            const params = [...vals, ...cols.map((k) => b[k])];
            const sets = cols.map((k, i) => `${k} = $${vals.length + i + 1}`).join(', ');
            const rows = await asRole(c, (q) => q.query(`update public.${t} set ${sets}${where} returning *`, params));
            return wantsRows ? json(res, 200, rows.rows) : (res.writeHead(204), res.end());
          }
          if (req.method === 'DELETE') {
            if (!eq.length) return json(res, 400, { message: 'filter required' });
            const rows = await asRole(c, (q) => q.query(`delete from public.${t}${where} returning *`, vals));
            return wantsRows ? json(res, 200, rows.rows) : (res.writeHead(204), res.end());
          }
        } catch (e: any) {
          return json(res, e.code === '42501' ? 403 : 400, { code: e.code, message: e.message });
        }
      }

      // ---- Storage stand-in (files in a temp dir; membership checked like the bucket policy does)
      const stor = /^\/storage\/v1\/object\/(?:(public)\/)?([a-z-]+)\/(.+)$/.exec(path);
      if (stor && opts.storageDir) {
        const [, isPublic, bucket, objectPath] = stor as unknown as [string, string | undefined, string, string];
        const file = join(opts.storageDir, bucket, normalize(decodeURIComponent(objectPath)).replace(/^(\.\.[/\\])+/, ''));
        if (req.method === 'GET' && isPublic) {
          if (!existsSync(file)) { res.writeHead(404); return res.end('not found'); }
          res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
          return res.end(readFileSync(file));
        }
        const c = claimsOf(req);
        if (c.role !== 'authenticated') return json(res, 401, { message: 'unauthorized' });
        const tenant = decodeURIComponent(objectPath).split('/')[0]!;
        const allowed = await asRole(c, async (q) => (await q.query(`select private.is_member($1::uuid) as ok`, [tenant])).rows[0]?.ok === true).catch(() => false);
        if (!allowed) return json(res, 403, { message: 'new row violates row-level security policy' });
        if (req.method === 'POST' || req.method === 'PUT') {
          const chunks: Buffer[] = [];
          for await (const ch of req) chunks.push(ch as Buffer);
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, Buffer.concat(chunks));
          return json(res, 200, { Key: `${bucket}/${decodeURIComponent(objectPath)}` });
        }
      }
      const storDel = /^\/storage\/v1\/object\/([a-z-]+)$/.exec(path);
      if (storDel && req.method === 'DELETE' && opts.storageDir) {
        const b = await body(req);
        for (const p of (b.prefixes ?? []) as string[]) rmSync(join(opts.storageDir, storDel[1]!, normalize(p)), { force: true });
        return json(res, 200, []);
      }

      // ---- Edge Function stand-in: the REAL assistant core, a keyword "model", real database calls
      if (path === '/functions/v1/assistant' && req.method === 'POST') {
        const b = await body(req);
        const c = claimsOf(req);
        const mode = b.mode === 'owner' ? 'owner' : 'client';
        const slug = String(b.slug ?? '');
        const callRpc = async (claims: Claims, fn: string, args: unknown[]) => {
          const ph = args.map((_, i) => `$${i + 1}`).join(', ');
          return asRole(claims, (q) => q.query(`select public.${fn}(${ph}) as r`, args as any[])).then((r) => r.rows[0]?.r);
        };
        try {
          if (mode === 'owner') {
            if (c.role !== 'authenticated') throw new AssistantError('unauthorized', 'Войдите в кабинет.');
            await callRpc(c, 'owner_context', [slug]).catch(() => { throw new AssistantError('unauthorized', 'Нет доступа к этой студии.'); });
          }
          const pub = await callRpc(c, 'studio_public', [slug]);
          if (!pub?.ok) throw new AssistantError('bad_request', 'Студия не найдена.');
          const st = pub.studio;
          const tenant = (await pool.query('select id from public.tenants where slug = $1', [slug])).rows[0];
          const must = (r: any) => { if (!r?.ok) throw new Error(r?.code ?? 'failed'); return r; };
          const providers: Providers = {
            timezone: st.timezone,
            studio: async () => st,
            availability: async (id, f, t) => must(await callRpc(c, 'availability', [slug, id, f, t])).slots,
            stats: async (f, t) => must(await callRpc(c, 'owner_stats', [slug, f, t])),
            bookings: async (f, t) => must(await callRpc(c, 'owner_bookings', [slug, f, t, false])).bookings,
          };
          const reply = await handleAssistant(b, mode, {
            llm: harnessLlm(), toolMode: 'native', limits: DEFAULT_LIMITS, providers, studio: { name: st.name, timezone: st.timezone },
            subject: c.sub ?? String(req.socket.remoteAddress),
            rateHit: async (bk, l, w) => (await pool.query('select public.rate_hit($1,$2,$3) as r', [bk, l, w])).rows[0].r,
            reserveBudget: async (cl, tl) => (await pool.query('select public.llm_reserve($1,$2,$3) as r', [tenant.id, cl, tl])).rows[0].r,
            addTokens: async (n) => { await pool.query('select public.llm_add_tokens($1,$2)', [tenant.id, n]); },
          });
          return json(res, 200, reply);
        } catch (e: any) {
          if (e instanceof AssistantError) return json(res, ({ bad_request: 400, rate_limited: 429, budget: 429, unauthorized: 401, unavailable: 503 } as const)[e.code], { error: e.code, message: e.message });
          return json(res, 500, { error: 'internal', message: e.message });
        }
      }

      // ---- GoTrue stand-in: password grant against harness users
      if (path === '/auth/v1/token' && req.method === 'POST') {
        const b = await body(req);
        const users = opts.users ?? {};
        const u = users[String(b.email ?? '').toLowerCase()];
        if (!u || u.password !== b.password) return json(res, 400, { error: 'invalid_grant', error_description: 'Invalid login credentials' });
        const token = fakeJwt(u.id);
        return json(res, 200, {
          access_token: token, token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'harness-refresh',
          user: { id: u.id, aud: 'authenticated', role: 'authenticated', email: b.email, app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() },
        });
      }
      if (path === '/auth/v1/logout') { res.writeHead(204); return res.end(); }

      // ---- static app with SPA fallback
      const rel = normalize(decodeURIComponent(path)).replace(/^(\.\.[/\\])+/, '');
      let file = join(opts.distDir, rel);
      if (!existsSync(file) || statSync(file).isDirectory()) {
        const m = /^\/s\/([a-z0-9-]+)\//.exec(path + '/');
        const perTenant = m && join(opts.distDir, 's', m[1]!, 'index.html');
        const isAsset = extname(path) !== '' && !path.endsWith('/');
        if (isAsset) { res.writeHead(404); return res.end('not found'); }
        file = perTenant && existsSync(perTenant) ? perTenant : join(opts.distDir, 'index.html');
      }
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(readFileSync(file));
    } catch (e: any) {
      json(res, 500, { message: e.message });
    }
  });

  await new Promise<void>((r) => server.listen(opts.port ?? 0, r));
  const port = (server.address() as any).port as number;
  return {
    url: `http://localhost:${port}`,
    server,
    pool,
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await pool.end();
    },
  };
}
