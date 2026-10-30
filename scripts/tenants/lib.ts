import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { businessSchema, WEEKDAYS, type BusinessConfig } from '../../src/shared/business-schema.js';

export const ROOT = resolve(import.meta.dirname, '..', '..');
export const TENANTS_DIR = join(ROOT, 'tenants');
export const PUBLIC_DIR = join(ROOT, 'public');

export type Exec = (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;

export async function listSlugs(): Promise<string[]> {
  const entries = await readdir(TENANTS_DIR, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory() && !e.name.startsWith('_')).map((e) => e.name).sort();
}

export const tenantDir = (slug: string) => join(TENANTS_DIR, slug);

export async function readRaw(slug: string): Promise<unknown> {
  const file = join(tenantDir(slug), 'business.json');
  if (!existsSync(file)) throw new Error(`нет файла tenants/${slug}/business.json`);
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    throw new Error(`tenants/${slug}/business.json: некорректный JSON (${(e as Error).message})`);
  }
}

// ------------------------------------------------------------------ validation
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const contrastOnBlack = (hex: string) => (luminance(hex) + 0.05) / 0.05;

export type Validation = { slug: string; ok: boolean; errors: string[]; warnings: string[]; config?: BusinessConfig };

export async function validateTenant(slug: string): Promise<Validation> {
  const errors: string[] = [];
  const warnings: string[] = [];
  let raw: unknown;
  try {
    raw = await readRaw(slug);
  } catch (e) {
    return { slug, ok: false, errors: [(e as Error).message], warnings };
  }
  const parsed = businessSchema.safeParse(raw);
  if (!parsed.success) {
    for (const i of parsed.error.issues) errors.push(`${i.path.join('.') || '(корень)'}: ${i.message}`);
    return { slug, ok: false, errors, warnings };
  }
  const cfg = parsed.data;
  if (cfg.slug !== slug) errors.push(`slug «${cfg.slug}» не совпадает с именем папки «${slug}»`);
  if (contrastOnBlack(cfg.accent) < 3) errors.push(`акцент ${cfg.accent} слишком тёмный для чёрного фона (контраст < 3:1)`);

  const checkImage = async (rel: string, label: string, minWidth: number) => {
    const file = join(tenantDir(slug), rel);
    if (!existsSync(file)) return void errors.push(`${label}: нет файла ${rel}`);
    const size = (await stat(file)).size;
    if (size > 8 * 1024 * 1024) errors.push(`${label}: файл ${rel} больше 8 МБ`);
    try {
      const meta = await sharp(file).metadata();
      if (!meta.format || !['jpeg', 'png', 'webp'].includes(meta.format)) errors.push(`${label}: ${rel} не JPEG/PNG/WebP`);
      else if ((meta.width ?? 0) < minWidth) warnings.push(`${label}: ${rel} шириной ${meta.width}px, лучше от ${minWidth}px`);
    } catch {
      errors.push(`${label}: ${rel} не читается как изображение`);
    }
  };
  await checkImage(cfg.images.logo, 'логотип', 256);
  await checkImage(cfg.images.hero, 'главное фото', 1000);
  for (const g of cfg.gallery) await checkImage(g.image, `фото «${g.key}»`, 600);

  const windows = WEEKDAYS.map((d) => cfg.hours[d]).filter(Boolean) as [string, string][];
  const longest = Math.max(...windows.map(([a, b]) => toMin(b) - toMin(a)));
  for (const s of cfg.services) {
    if (s.durationMinutes > longest && s.durationMinutes < 24 * 60) {
      warnings.push(`услуга «${s.key}» (${s.durationMinutes} мин) длиннее рабочего окна — будет считаться многодневной`);
    }
  }
  if (!cfg.isDemo && /\.example$|@example\./.test(cfg.owner.email)) warnings.push('у боевой студии e-mail владельца — заглушка');
  if (cfg.isDemo) warnings.push('студия помечена isDemo: данные образца');
  return { slug, ok: errors.length === 0, errors, warnings, config: cfg };
}

const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

// ------------------------------------------------------------------ media
export type MediaUrls = { logo: string; hero: string; gallery: Record<string, string> };

export const mediaUrlBase = (slug: string) => `/s/${slug}/media`;

export function plannedMediaUrls(cfg: BusinessConfig): MediaUrls {
  const base = mediaUrlBase(cfg.slug);
  return {
    logo: `${base}/logo.png`,
    hero: `${base}/hero.jpg`,
    gallery: Object.fromEntries(cfg.gallery.map((g) => [g.key, `${base}/${g.key}.jpg`])),
  };
}

/** Resize/optimise the studio's images into public/s/<slug>/media (static assets of the build). */
export async function processMedia(cfg: BusinessConfig, outRoot = PUBLIC_DIR): Promise<MediaUrls> {
  const src = (rel: string) => join(tenantDir(cfg.slug), rel);
  const out = join(outRoot, 's', cfg.slug, 'media');
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await sharp(src(cfg.images.hero)).rotate().resize({ width: 1600, withoutEnlargement: true }).jpeg({ quality: 82, mozjpeg: true }).toFile(join(out, 'hero.jpg'));
  await sharp(src(cfg.images.logo)).resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toFile(join(out, 'logo.png'));
  for (const g of cfg.gallery) {
    await sharp(src(g.image)).rotate().resize({ width: 1200, withoutEnlargement: true }).jpeg({ quality: 80, mozjpeg: true }).toFile(join(out, `${g.key}.jpg`));
  }
  return plannedMediaUrls(cfg);
}

// ------------------------------------------------------------------ publish (DB)
/**
 * Writes the configuration into the database. One code path serves the real publish
 * (a transaction on DATABASE_URL) and seed generation (statements recorded and inlined).
 *
 * Re-publishing is safe by construction:
 *  - bookings, payments, tokens are never touched;
 *  - items are matched by config_key; things removed from the config are deactivated or
 *    removed only if they came from the config (gallery origin='config');
 *  - photos uploaded by the owner (origin='owner') and owner-made catalog rows stay;
 *  - tenants.status is preserved: a live studio stays live.
 */
export async function publishTenant(exec: Exec, cfg: BusinessConfig, urls: MediaUrls): Promise<void> {
  const T = '(select id from public.tenants where slug = $1)';
  const slug = cfg.slug;

  await exec(
    `insert into public.tenants (slug, name, tagline, description, timezone, accent, is_demo, address, phone,
        logo_url, hero_url, hero_alt, slot_step_minutes, lead_time_minutes, cancel_before_hours, max_horizon_days)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     on conflict (slug) do update set
        name = excluded.name, tagline = excluded.tagline, description = excluded.description,
        timezone = excluded.timezone, accent = excluded.accent, is_demo = excluded.is_demo,
        address = excluded.address, phone = excluded.phone, logo_url = excluded.logo_url,
        hero_url = excluded.hero_url, hero_alt = excluded.hero_alt,
        slot_step_minutes = excluded.slot_step_minutes, lead_time_minutes = excluded.lead_time_minutes,
        cancel_before_hours = excluded.cancel_before_hours, max_horizon_days = excluded.max_horizon_days,
        config_version = public.tenants.config_version + 1, updated_at = now()`,
    [slug, cfg.name, cfg.tagline, cfg.description, cfg.timezone, cfg.accent, cfg.isDemo, cfg.contacts.address,
      cfg.contacts.phone, urls.logo, urls.hero, cfg.images.heroAlt, cfg.booking.slotStepMinutes,
      cfg.booking.leadTimeMinutes, cfg.booking.cancelBeforeHours, cfg.booking.maxHorizonDays],
  );

  // resources
  for (const [i, r] of cfg.resources.entries()) {
    await exec(
      `insert into public.resources (tenant_id, name, sort, config_key, active)
       values (${T}, $2, $3, $4, true)
       on conflict (tenant_id, config_key) do update set name = excluded.name, sort = excluded.sort, active = true`,
      [slug, r.name, i, r.key],
    );
  }
  await deactivateMissing(exec, 'resources', slug, cfg.resources.map((r) => r.key));

  // services
  for (const [i, s] of cfg.services.entries()) {
    await exec(
      `insert into public.services (tenant_id, name, description, price_cents, duration_minutes, buffer_minutes, sort, config_key, active)
       values (${T}, $2, $3, $4, $5, $6, $7, $8, true)
       on conflict (tenant_id, config_key) do update set name = excluded.name, description = excluded.description,
         price_cents = excluded.price_cents, duration_minutes = excluded.duration_minutes,
         buffer_minutes = excluded.buffer_minutes, sort = excluded.sort, active = true`,
      [slug, s.name, s.description, s.price * 100, s.durationMinutes, s.bufferMinutes, i, s.key],
    );
  }
  await deactivateMissing(exec, 'services', slug, cfg.services.map((s) => s.key));

  // which boxes fit which service (config-managed services only)
  await exec(
    `delete from public.service_resources where tenant_id = ${T}
       and service_id in (select id from public.services where tenant_id = ${T} and config_key is not null)`,
    [slug],
  );
  for (const s of cfg.services) {
    for (const rk of s.resources ?? []) {
      await exec(
        `insert into public.service_resources (tenant_id, service_id, resource_id)
         values (${T},
           (select id from public.services  where tenant_id = ${T} and config_key = $2),
           (select id from public.resources where tenant_id = ${T} and config_key = $3))`,
        [slug, s.key, rk],
      );
    }
  }

  // working hours
  await exec(`delete from public.working_hours where tenant_id = ${T}`, [slug]);
  for (const [idx, d] of WEEKDAYS.entries()) {
    const h = cfg.hours[d];
    if (h) {
      await exec(`insert into public.working_hours (tenant_id, weekday, opens, closes) values (${T}, $2, $3, $4)`, [slug, idx + 1, h[0], h[1]]);
    }
  }

  // info cards
  for (const [i, c] of cfg.cards.entries()) {
    await exec(
      `insert into public.info_cards (tenant_id, position, title, body) values (${T}, $2, $3, $4)
       on conflict (tenant_id, position) do update set title = excluded.title, body = excluded.body`,
      [slug, i + 1, c.title, c.body],
    );
  }

  // gallery: config photos are managed here; owner photos are never touched
  for (const [i, g] of cfg.gallery.entries()) {
    await exec(
      `insert into public.gallery_items (tenant_id, image_url, caption, sort, origin, config_key)
       values (${T}, $2, $3, $4, 'config', $5)
       on conflict (tenant_id, config_key) do update set image_url = excluded.image_url, caption = excluded.caption, sort = excluded.sort`,
      [slug, urls.gallery[g.key], g.caption, i, g.key],
    );
  }
  const keys = cfg.gallery.map((g) => g.key);
  const ph = keys.map((_, i) => `$${i + 2}`).join(', ');
  await exec(
    `delete from public.gallery_items where tenant_id = ${T} and origin = 'config'
       ${keys.length ? `and config_key not in (${ph})` : ''}`,
    [slug, ...keys],
  );
}

async function deactivateMissing(exec: Exec, table: 'resources' | 'services', slug: string, keys: string[]) {
  const ph = keys.map((_, i) => `$${i + 2}`).join(', ');
  await exec(
    `update public.${table} set active = false
      where tenant_id = (select id from public.tenants where slug = $1)
        and config_key is not null and config_key not in (${ph})`,
    [slug, ...keys],
  );
}

// ------------------------------------------------------------------ seed rendering
export function inlineSql(sql: string, params: unknown[] = []): string {
  const lit = (v: unknown): string => {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'number') return String(v);
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    return `'${String(v).replace(/'/g, "''")}'`;
  };
  return sql.replace(/\$(\d+)/g, (_, n) => lit(params[Number(n) - 1]));
}

export async function renderSeed(slugs: string[]): Promise<string> {
  const out: string[] = [
    '-- GENERATED by `pnpm tenant:seed` from tenants/*/business.json. Do not edit by hand.',
    '-- Demo studios stay in `preview` (sample) status until `pnpm tenant:verify <slug> --activate`.',
    'begin;',
  ];
  for (const slug of slugs) {
    const v = await validateTenant(slug);
    if (!v.ok || !v.config) throw new Error(`tenants/${slug}: ${v.errors.join('; ')}`);
    out.push(`-- ${v.config.name} (${slug})`);
    const exec: Exec = async (sql, params) => {
      out.push(inlineSql(sql.replace(/\s+/g, ' ').trim(), params) + ';');
      return { rows: [] };
    };
    await publishTenant(exec, v.config, plannedMediaUrls(v.config));
  }
  out.push('commit;', '');
  return out.join('\n');
}

export async function writeSeed(file = join(ROOT, 'supabase', 'seed.sql')): Promise<string> {
  const slugs: string[] = [];
  for (const s of await listSlugs()) {
    const v = await validateTenant(s);
    if (v.config?.isDemo) slugs.push(s);
  }
  const text = await renderSeed(slugs);
  await mkdir(join(ROOT, 'supabase'), { recursive: true });
  await writeFile(file, text);
  return file;
}

// ------------------------------------------------------------------ scaffolding
export async function scaffoldTenant(slug: string, opts: { name?: string; accent?: string; from?: string } = {}): Promise<string> {
  if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(slug)) throw new Error('slug: 3–40 символов, латиница, цифры, дефис');
  const dir = tenantDir(slug);
  if (existsSync(dir)) throw new Error(`tenants/${slug} уже существует`);
  const from = opts.from ? tenantDir(opts.from) : join(TENANTS_DIR, '_template');
  if (!existsSync(from)) throw new Error(`нет образца ${opts.from ?? '_template'}`);
  await cp(from, dir, { recursive: true });
  const file = join(dir, 'business.json');
  const cfg = JSON.parse(await readFile(file, 'utf8'));
  cfg.slug = slug;
  cfg.name = opts.name ?? cfg.name;
  if (opts.accent) cfg.accent = opts.accent;
  cfg.isDemo = true;
  cfg.owner = { email: `owner@${slug}.example` };
  await writeFile(file, JSON.stringify(cfg, null, 2) + '\n');
  return dir;
}
