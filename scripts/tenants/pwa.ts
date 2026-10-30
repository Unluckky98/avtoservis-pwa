import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import type { BusinessConfig } from '../../src/shared/business-schema.js';
import { listSlugs, processMedia, validateTenant } from './lib.js';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** iPhone launch-image sizes: [css width, css height, pixel ratio]. */
const STARTUP: Array<[number, number, number]> = [
  [430, 932, 3], [393, 852, 3], [428, 926, 3], [390, 844, 3], [375, 812, 3], [414, 896, 2], [375, 667, 2],
];

async function squareIcon(logo: string, size: number, padRatio: number, bg: string, out: string) {
  const inner = Math.round(size * (1 - 2 * padRatio));
  const glyph = await sharp(logo).resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  await sharp({ create: { width: size, height: size, channels: 4, background: bg } })
    .composite([{ input: glyph, gravity: 'center' }])
    .png()
    .toFile(out);
}

export function manifestFor(cfg: BusinessConfig) {
  const scope = `/s/${cfg.slug}/`;
  return {
    id: scope,
    name: cfg.name,
    short_name: cfg.name.length > 12 ? cfg.name.split(/\s+/)[0]!.slice(0, 12) : cfg.name,
    description: cfg.tagline,
    lang: 'ru',
    start_url: scope,
    scope,
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#000000',
    theme_color: '#000000',
    icons: [
      { src: `${scope}icons/icon-192.png`, sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: `${scope}icons/icon-512.png`, sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: `${scope}icons/maskable-512.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}

/** The studio-specific document: same bundle, but title, description, manifest, icons and theme belong to this studio. */
export function shellFor(cfg: BusinessConfig, baseHtml: string): string {
  const scope = `/s/${cfg.slug}/`;
  const startup = STARTUP.map(
    ([w, h, r]) => `    <link rel="apple-touch-startup-image" media="(device-width: ${w}px) and (device-height: ${h}px) and (-webkit-device-pixel-ratio: ${r}) and (orientation: portrait)" href="${scope}icons/startup-${w * r}x${h * r}.png" />`,
  ).join('\n');
  const head = [
    `    <title>${esc(cfg.name)}</title>`,
    `    <meta name="description" content="${esc(cfg.tagline || cfg.description.slice(0, 150))}" />`,
    `    <meta name="application-name" content="${esc(cfg.name)}" />`,
    `    <meta name="apple-mobile-web-app-title" content="${esc(cfg.name)}" />`,
    `    <meta name="apple-mobile-web-app-capable" content="yes" />`,
    `    <meta name="mobile-web-app-capable" content="yes" />`,
    `    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />`,
    `    <meta property="og:title" content="${esc(cfg.name)}" />`,
    `    <meta property="og:description" content="${esc(cfg.tagline)}" />`,
    `    <meta property="og:image" content="${scope}media/hero.jpg" />`,
    `    <link rel="manifest" href="${scope}manifest.webmanifest" />`,
    `    <link rel="icon" type="image/png" sizes="192x192" href="${scope}icons/icon-192.png" />`,
    `    <link rel="apple-touch-icon" href="${scope}icons/apple-touch-icon.png" />`,
    startup,
  ].join('\n');
  return baseHtml
    .replace(/<title>[\s\S]*?<\/title>/, '')
    .replace('</head>', `${head}\n  </head>`)
    .replace(/<meta name="theme-color"[^>]*>/, `<meta name="theme-color" content="#000000" />`);
}

export async function buildTenantPwa(cfg: BusinessConfig, distDir: string): Promise<string[]> {
  const out = join(distDir, 's', cfg.slug);
  const icons = join(out, 'icons');
  await mkdir(icons, { recursive: true });
  await processMedia(cfg, distDir); // media straight into dist: the build does not depend on a previous publish
  const logo = join(out, 'media', 'logo.png');

  await squareIcon(logo, 192, 0.1, '#000000', join(icons, 'icon-192.png'));
  await squareIcon(logo, 512, 0.1, '#000000', join(icons, 'icon-512.png'));
  await squareIcon(logo, 512, 0.22, '#000000', join(icons, 'maskable-512.png')); // content inside the 80% safe zone
  await squareIcon(logo, 180, 0.12, '#000000', join(icons, 'apple-touch-icon.png'));
  for (const [w, h, r] of STARTUP) {
    const W = w * r, H = h * r;
    const mark = await sharp(logo).resize(Math.round(W * 0.3)).png().toBuffer();
    await sharp({ create: { width: W, height: H, channels: 4, background: '#000000' } })
      .composite([{ input: mark, gravity: 'center' }])
      .png()
      .toFile(join(icons, `startup-${W}x${H}.png`));
  }

  await writeFile(join(out, 'manifest.webmanifest'), JSON.stringify(manifestFor(cfg), null, 2));
  const base = await readFile(join(distDir, 'index.html'), 'utf8');
  await writeFile(join(out, 'index.html'), shellFor(cfg, base));
  await copyFile(join(distDir, 'sw.js'), join(out, 'sw.js'));
  return [out];
}

/** Hosting rules: deep links of any studio are answered with that studio's own shell (static files win first). */
export async function writeHostingRules(distDir: string) {
  await writeFile(join(distDir, '_redirects'), '/s/:slug/* /s/:slug/index.html 200\n');
  await writeFile(join(distDir, '_headers'), ['/s/*/sw.js', '  Cache-Control: no-cache', '  Service-Worker-Allowed: /s/', '', '/s/*/index.html', '  Cache-Control: no-cache', '', '/s/*/manifest.webmanifest', '  Cache-Control: no-cache', ''].join('\n'));
}

export async function buildAll(distDir: string, only?: string[]) {
  const slugs = only?.length ? only : await listSlugs();
  const built: string[] = [];
  for (const slug of slugs) {
    const v = await validateTenant(slug);
    if (!v.ok || !v.config) throw new Error(`Студия ${slug} не прошла проверку: ${v.errors.join('; ')}`);
    await buildTenantPwa(v.config, distDir);
    built.push(slug);
  }
  await writeHostingRules(distDir);
  return built;
}
