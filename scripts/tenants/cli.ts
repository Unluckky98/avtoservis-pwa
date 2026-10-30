import { existsSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { randomBytes } from 'node:crypto';
import { ROOT, listSlugs, processMedia, publishTenant, scaffoldTenant, validateTenant, writeSeed, type Exec } from './lib.js';
import { verifyAll } from './verify.js';

const [cmd, ...rest] = process.argv.slice(2);
const flags = new Map<string, string | true>();
const pos: string[] = [];
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a.startsWith('--')) {
    const next = rest[i + 1];
    if (next && !next.startsWith('--')) { flags.set(a.slice(2), next); i++; } else flags.set(a.slice(2), true);
  } else pos.push(a);
}
const flag = (n: string) => flags.get(n);

const usage = `Использование:
  pnpm tenant:new <slug> [--name "Название"] [--accent "#4690FF"] [--from <slug>]
  pnpm tenant:validate <slug> | --all
  pnpm tenant:publish <slug> [--dry-run]            (нужен DATABASE_URL)
  pnpm tenant:verify <slug> [--dist dist] [--url https://...] [--activate]
  pnpm tenant:seed                                  (пересобрать supabase/seed.sql из демо-студий)
  pnpm owner:create <slug>                          (нужны SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)`;

const mark = (s: string) => ({ pass: '✓', fail: '✗', skip: '–' } as Record<string, string>)[s];

async function withDb<T>(fn: (exec: Exec, client: pg.Client) => Promise<T>): Promise<T> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('не задан DATABASE_URL (строка подключения к Postgres проекта Supabase)');
  const client = new pg.Client({ connectionString: url, ssl: /localhost|127\.0\.0\.1|:\/\/[^@]*@\/?|host=/.test(url) ? undefined : { rejectUnauthorized: false } });
  await client.connect();
  try {
    return await fn((sql, params) => client.query(sql, params as any[]), client);
  } finally {
    await client.end();
  }
}

async function main() {
  switch (cmd) {
    case 'new': {
      const slug = pos[0];
      if (!slug) throw new Error(usage);
      const dir = await scaffoldTenant(slug, { name: flag('name') as string | undefined, accent: flag('accent') as string | undefined, from: flag('from') as string | undefined });
      console.log(`Создано: ${dir}\nДальше:\n  1) отредактируйте tenants/${slug}/business.json и положите фото в tenants/${slug}/media/\n  2) pnpm tenant:validate ${slug}\n  3) pnpm tenant:publish ${slug}\n  4) pnpm build && pnpm tenant:verify ${slug} --dist dist --activate`);
      return;
    }
    case 'validate': {
      const slugs = flag('all') ? await listSlugs() : pos.length ? pos : [];
      if (!slugs.length) throw new Error(usage);
      let failed = false;
      for (const s of slugs) {
        const v = await validateTenant(s);
        console.log(`${v.ok ? '✓' : '✗'} ${s}`);
        v.errors.forEach((e) => console.log(`    ошибка: ${e}`));
        v.warnings.forEach((w) => console.log(`    замечание: ${w}`));
        failed ||= !v.ok;
      }
      process.exit(failed ? 1 : 0);
      return;
    }
    case 'publish': {
      const slug = pos[0];
      if (!slug) throw new Error(usage);
      const v = await validateTenant(slug);
      if (!v.ok || !v.config) { v.errors.forEach((e) => console.error(`ошибка: ${e}`)); process.exit(1); }
      const cfg = v.config!;
      const urls = await processMedia(cfg);
      console.log(`Изображения подготовлены: public/s/${slug}/media`);
      if (flag('dry-run')) { console.log('--dry-run: база не тронута.'); return; }
      await withDb(async (exec, client) => {
        await client.query('begin');
        try { await publishTenant(exec, cfg, urls); await client.query('commit'); } catch (e) { await client.query('rollback'); throw e; }
        const [{ status }] = (await client.query('select status from public.tenants where slug = $1', [slug])).rows;
        console.log(`Опубликовано в базе: ${cfg.name} (статус: ${status}). Записи и фото владельца не затронуты.`);
        if (status !== 'live') console.log(`Студия доступна как образец. Для боевого режима: pnpm tenant:verify ${slug} --activate`);
      });
      return;
    }
    case 'verify': {
      const slug = pos[0];
      if (!slug) throw new Error(usage);
      const distDir = flag('dist') ? join(ROOT, String(flag('dist') === true ? 'dist' : flag('dist'))) : undefined;
      const url = flag('url') ? String(flag('url')) : undefined;
      const run = async (exec?: Exec) => verifyAll({ slug, exec, distDir, url });
      const result = process.env.DATABASE_URL ? await withDb((exec) => run(exec)) : await run();
      for (const c of result.checks) console.log(`${mark(c.status)} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
      if (!result.ok) { console.log('\nПроверка НЕ пройдена.'); process.exit(1); }
      if (flag('activate')) {
        if (!process.env.DATABASE_URL) throw new Error('для --activate нужен DATABASE_URL');
        if (result.checks.some((c) => c.name.startsWith('база') && c.status === 'skip')) throw new Error('нельзя активировать без проверки базы');
        await withDb(async (exec) => { await exec(`update public.tenants set status = 'live', updated_at = now() where slug = $1`, [slug]); });
        console.log(`\nСтудия ${slug} переведена в live.`);
      } else console.log('\nПроверка пройдена. Для боевого режима добавьте --activate.');
      return;
    }
    case 'seed': {
      const file = await writeSeed();
      console.log(`Записано: ${file}`);
      return;
    }
    case 'owner': {
      const slug = pos[0] === 'create' ? pos[1] : pos[0];
      if (!slug) throw new Error(usage);
      const v = await validateTenant(slug);
      if (!v.config) throw new Error(v.errors.join('; '));
      const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
      if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error('нужны SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY');
      const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
      const email = v.config.owner.email;
      const password = process.env.OWNER_PASSWORD ?? randomBytes(9).toString('base64url');
      let userId: string | undefined;
      const created = await sb.auth.admin.createUser({ email, password, email_confirm: true });
      if (created.error) {
        const list = await sb.auth.admin.listUsers({ page: 1, perPage: 1000 });
        userId = list.data?.users.find((u) => u.email?.toLowerCase() === email.toLowerCase())?.id;
        if (!userId) throw new Error(`не удалось создать владельца: ${created.error.message}`);
        console.log(`Пользователь ${email} уже существует, пароль не менялся.`);
      } else {
        userId = created.data.user.id;
        console.log(`Создан владелец ${email}\nПароль (покажем один раз): ${password}`);
      }
      const { data: t } = await sb.from('tenants').select('id').eq('slug', slug).single();
      if (!t) throw new Error(`студия ${slug} ещё не опубликована: pnpm tenant:publish ${slug}`);
      const { error } = await sb.from('tenant_members').upsert({ tenant_id: t.id, user_id: userId, role: 'owner' });
      if (error) throw new Error(error.message);
      console.log(`Привязан к студии ${slug}. Кабинет: /s/${slug}/owner/`);
      return;
    }
    default:
      console.log(usage);
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((e) => { console.error(`Ошибка: ${e.message}`); process.exit(1); });
void existsSync;
