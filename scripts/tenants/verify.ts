import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WEEKDAYS, type BusinessConfig } from '../../src/shared/business-schema.js';
import { plannedMediaUrls, validateTenant, type Exec } from './lib.js';

export type Check = { name: string; status: 'pass' | 'fail' | 'skip'; detail?: string };

const ok = (name: string, detail?: string): Check => ({ name, status: 'pass', detail });
const bad = (name: string, detail: string): Check => ({ name, status: 'fail', detail });
const skip = (name: string, detail: string): Check => ({ name, status: 'skip', detail });

const localDate = (tz: string, plusDays = 0) =>
  new Date(Date.now() + plusDays * 86400_000).toLocaleDateString('sv-SE', { timeZone: tz });

/** Checks the published database state against business.json. */
export async function verifyDb(exec: Exec, cfg: BusinessConfig): Promise<Check[]> {
  const checks: Check[] = [];
  const res = (await exec(`select public.studio_public($1) as r`, [cfg.slug])).rows[0]?.r;
  if (!res?.ok) return [bad('база: студия опубликована', 'studio_public не нашла студию — запустите tenant:publish')];
  const s = res.studio;
  checks.push(ok('база: студия опубликована', `статус: ${s.preview ? 'preview (образец)' : 'live'}`));

  const diffs: string[] = [];
  if (s.name !== cfg.name) diffs.push('name');
  if (s.accent.toLowerCase() !== cfg.accent.toLowerCase()) diffs.push('accent');
  if (s.phone !== cfg.contacts.phone) diffs.push('phone');
  if (s.address !== cfg.contacts.address) diffs.push('address');
  if (s.timezone !== cfg.timezone) diffs.push('timezone');
  if (s.hero_url !== plannedMediaUrls(cfg).hero) diffs.push('hero_url');
  checks.push(diffs.length ? bad('база: основные поля совпадают с конфигом', `расходятся: ${diffs.join(', ')}`) : ok('база: основные поля совпадают с конфигом'));

  const missing = cfg.services.filter(
    (c) => !s.services.some((x: any) => x.name === c.name && x.price_cents === c.price * 100 && x.duration_minutes === c.durationMinutes),
  );
  checks.push(missing.length ? bad('база: услуги и цены', `нет или отличаются: ${missing.map((m) => m.key).join(', ')}`) : ok('база: услуги и цены', `${cfg.services.length} шт.`));

  const hoursBad = WEEKDAYS.flatMap((d, i) => {
    const want = cfg.hours[d];
    const got = s.hours.find((h: any) => h.weekday === i + 1);
    if (!want) return got ? [d] : [];
    return got && got.opens === want[0] && got.closes === want[1] ? [] : [d];
  });
  checks.push(hoursBad.length ? bad('база: график работы', `расходится: ${hoursBad.join(', ')}`) : ok('база: график работы'));

  checks.push(s.cards.length === 3 ? ok('база: три информационные карточки') : bad('база: три информационные карточки', `найдено ${s.cards.length}`));
  const urls = plannedMediaUrls(cfg).gallery;
  const noPhoto = cfg.gallery.filter((g) => !s.gallery.some((x: any) => x.image_url === urls[g.key]));
  checks.push(noPhoto.length ? bad('база: фотографии работ', `нет: ${noPhoto.map((g) => g.key).join(', ')}`) : ok('база: фотографии работ', `${cfg.gallery.length} шт.`));

  // the schedule must really produce bookable time
  const first = s.services[0];
  const av = (await exec(`select public.availability($1, $2, $3::date, $4::date) as r`, [cfg.slug, first.id, localDate(cfg.timezone), localDate(cfg.timezone, 14)])).rows[0].r;
  const free = av.ok ? av.slots.filter((x: any) => x.available).length : 0;
  checks.push(free > 0 ? ok('база: есть свободные окна на 14 дней', `${free} окон по услуге «${first.name}»`) : bad('база: есть свободные окна на 14 дней', 'ни одного свободного окна — проверьте график, боксы и услуги'));
  return checks;
}

/** Checks the built static output for the studio (dist folder). */
export async function verifyDist(distDir: string, cfg: BusinessConfig): Promise<Check[]> {
  const base = join(distDir, 's', cfg.slug);
  const scope = `/s/${cfg.slug}/`;
  if (!existsSync(base)) return [skip('сборка: файлы студии', `нет ${base} — выполните pnpm build`)];
  const checks: Check[] = [];
  const need = ['index.html', 'manifest.webmanifest', 'sw.js', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-touch-icon.png', 'media/hero.jpg', 'media/logo.png'];
  const absent = need.filter((f) => !existsSync(join(base, f)));
  checks.push(absent.length ? bad('сборка: файлы студии', `нет: ${absent.join(', ')}`) : ok('сборка: файлы студии'));
  if (existsSync(join(base, 'index.html'))) {
    const html = await readFile(join(base, 'index.html'), 'utf8');
    const titleOk = new RegExp(`<title>[^<]*${escapeRe(cfg.name)}[^<]*</title>`).test(html);
    const manifestLink = html.includes(`href="${scope}manifest.webmanifest"`);
    const apple = html.includes(`${scope}icons/apple-touch-icon.png`);
    const theme = html.toLowerCase().includes('name="theme-color"');
    const bad_ = [!titleOk && 'title', !manifestLink && 'manifest', !apple && 'apple-touch-icon', !theme && 'theme-color'].filter(Boolean);
    checks.push(bad_.length ? bad('сборка: HTML-метаданные студии', `нет: ${bad_.join(', ')}`) : ok('сборка: HTML-метаданные студии'));
  }
  if (existsSync(join(base, 'manifest.webmanifest'))) {
    const m = JSON.parse(await readFile(join(base, 'manifest.webmanifest'), 'utf8'));
    const problems: string[] = [];
    if (m.id !== scope) problems.push(`id=${m.id}`);
    if (m.start_url !== scope) problems.push(`start_url=${m.start_url}`);
    if (m.scope !== scope) problems.push(`scope=${m.scope}`);
    if (m.display !== 'standalone') problems.push('display');
    if (m.name !== cfg.name) problems.push('name');
    if (!m.icons?.some((i: any) => i.sizes === '512x512' && /maskable/.test(i.purpose ?? ''))) problems.push('maskable-иконка');
    checks.push(problems.length ? bad('сборка: manifest', problems.join(', ')) : ok('сборка: manifest', `id/start_url/scope = ${scope}`));
  }
  const redirects = existsSync(join(distDir, '_redirects')) ? await readFile(join(distDir, '_redirects'), 'utf8') : '';
  const hasRule = redirects.includes(`${scope}* ${scope}index.html 200`) || redirects.includes('/s/:slug/* /s/:slug/index.html 200');
  checks.push(hasRule ? ok('сборка: глубокие ссылки ведут в оболочку студии') : bad('сборка: глубокие ссылки ведут в оболочку студии', 'нет правила в _redirects'));
  return checks;
}

/** Checks a deployed URL (or a local preview server). */
export async function verifyUrl(baseUrl: string, cfg: BusinessConfig): Promise<Check[]> {
  const base = baseUrl.replace(/\/$/, '');
  const scope = `/s/${cfg.slug}/`;
  const checks: Check[] = [];
  const get = async (path: string) => {
    try {
      return await fetch(base + path, { redirect: 'follow' });
    } catch (e) {
      return { ok: false, status: 0, headers: new Headers(), text: async () => '', err: (e as Error).message } as any;
    }
  };
  for (const [label, path, needle] of [
    ['главная студии', scope, cfg.name],
    ['глубокая ссылка кабинета', `${scope}owner/`, cfg.name],
    ['глубокая ссылка «Моя запись»', `${scope}my-booking`, cfg.name],
  ] as const) {
    const r = await get(path);
    const text = r.ok ? await r.text() : '';
    checks.push(r.ok && text.includes(needle) ? ok(`ссылка: ${label}`, `${path} → ${r.status}`) : bad(`ссылка: ${label}`, `${path} → ${r.status}${r.ok ? ', нет названия студии в HTML' : ''}`));
  }
  const m = await get(`${scope}manifest.webmanifest`);
  checks.push(m.ok ? ok('ссылка: manifest') : bad('ссылка: manifest', `статус ${m.status}`));
  const img = await get(plannedMediaUrls(cfg).hero);
  checks.push(img.ok && /image\//.test(img.headers.get('content-type') ?? '') ? ok('ссылка: главное фото') : bad('ссылка: главное фото', `статус ${img.status}`));
  return checks;
}

export async function verifyAll(opts: { slug: string; exec?: Exec; distDir?: string; url?: string }): Promise<{ checks: Check[]; ok: boolean }> {
  const v = await validateTenant(opts.slug);
  const checks: Check[] = [v.ok ? ok('конфиг: business.json и изображения корректны', v.warnings.length ? `предупреждений: ${v.warnings.length}` : undefined) : bad('конфиг: business.json и изображения корректны', v.errors.join('; '))];
  if (!v.config) return { checks, ok: false };
  checks.push(...(opts.exec ? await verifyDb(opts.exec, v.config) : [skip('база', 'не задан DATABASE_URL')]));
  checks.push(...(opts.distDir ? await verifyDist(opts.distDir, v.config) : [skip('сборка', 'не задан --dist')]));
  checks.push(...(opts.url ? await verifyUrl(opts.url, v.config) : [skip('ссылка', 'не задан --url')]));
  return { checks, ok: checks.every((c) => c.status !== 'fail') };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
