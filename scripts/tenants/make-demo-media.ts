/**
 * Generates TEMPORARY sample images for the demo studios (abstract dark car scenes).
 * Real photos supplied by an owner always replace these: drop them into tenants/<slug>/media/
 * with the file names used in business.json and run `pnpm tenant:publish <slug>`.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';

const ROOT = join(import.meta.dirname, '..', '..', 'tenants');

type Scene = { w: number; h: number; body: string; accent: string; zoom?: number; cx?: number; cy?: number; glow?: number };

function car(color: string, accent: string) {
  return `
  <g>
    <path d="M60 300 L60 252 Q70 222 130 212 L262 192 Q332 122 452 107 L642 107 Q742 112 802 177 L902 197 Q952 207 952 252 L952 300 Z" fill="${color}"/>
    <path d="M292 190 Q348 135 456 122 L634 122 Q716 126 764 180 Z" fill="#0b0d12" opacity=".92"/>
    <path d="M60 252 Q70 222 130 212 L262 192" fill="none" stroke="${accent}" stroke-width="3" opacity=".9"/>
    <path d="M452 107 L642 107" stroke="#fff" stroke-width="2" opacity=".35"/>
    <rect x="600" y="228" width="120" height="6" rx="3" fill="${accent}" opacity=".85"/>
    <g fill="#07080c"><circle cx="262" cy="300" r="64"/><circle cx="742" cy="300" r="64"/></g>
    <g fill="none" stroke="#8c93a3" stroke-width="5"><circle cx="262" cy="300" r="40"/><circle cx="742" cy="300" r="40"/></g>
    <g stroke="#8c93a3" stroke-width="4"><path d="M262 262v76M224 300h76M235 273l54 54M289 273l-54 54"/><path d="M742 262v76M704 300h76M715 273l54 54M769 273l-54 54"/></g>
  </g>`;
}

function sceneSvg(s: Scene) {
  const { w, h } = s;
  const zoom = s.zoom ?? 1;
  const cx = s.cx ?? 500;
  const cy = s.cy ?? 220;
  const tx = w / 2 - cx * zoom * (w / 1000);
  const ty = h / 2 - cy * zoom * (w / 1000);
  const k = zoom * (w / 1000);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <radialGradient id="bg" cx="${(s.glow ?? 0.7) * 100}%" cy="30%" r="90%">
      <stop offset="0" stop-color="${s.accent}" stop-opacity=".38"/>
      <stop offset=".45" stop-color="#10131a"/>
      <stop offset="1" stop-color="#050608"/>
    </radialGradient>
    <linearGradient id="floor" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity=".07"/><stop offset="1" stop-color="#000" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#bg)"/>
  <g stroke="#ffffff" stroke-opacity=".05">${Array.from({ length: 14 }, (_, i) => `<path d="M0 ${h * 0.62 + i * 28}H${w}"/>`).join('')}</g>
  <rect y="${h * 0.62}" width="${w}" height="${h * 0.38}" fill="url(#floor)"/>
  <g transform="translate(${tx} ${ty}) scale(${k})">${car(s.body, s.accent)}</g>
</svg>`;
}

async function jpg(path: string, s: Scene) {
  await sharp(Buffer.from(sceneSvg(s))).jpeg({ quality: 82, mozjpeg: true }).toFile(path);
}

async function logo(path: string, accent: string) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
    <rect width="512" height="512" rx="112" fill="#0b0d12"/>
    <path d="M256 92 L392 170 V342 L256 420 L120 342 V170 Z" fill="none" stroke="${accent}" stroke-width="26" stroke-linejoin="round"/>
    <path d="M176 300 L256 180 L336 300" fill="none" stroke="#fff" stroke-width="26" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(path);
}

const sets: Record<string, { accent: string; colors: string[] }> = {
  graphite: { accent: '#4690FF', colors: ['#2a2f3a', '#3a4150', '#1c2029', '#4a5062', '#262b36', '#394055'] },
  garage47: { accent: '#FF8A3D', colors: ['#3a2c26', '#4a352b', '#2b2220', '#5b4034', '#33272a', '#473227'] },
  'new-studio': { accent: '#4690FF', colors: ['#2a2f3a', '#3a4150'] },
};

for (const [slug, cfg] of Object.entries(sets)) {
  const dir = slug === 'new-studio' ? join(ROOT, '_template', 'media') : join(ROOT, slug, 'media');
  await mkdir(dir, { recursive: true });
  await logo(join(dir, 'logo.png'), cfg.accent);
  await jpg(join(dir, 'hero.jpg'), { w: 1600, h: 1100, body: cfg.colors[0], accent: cfg.accent, zoom: 1.0, cx: 500, cy: 215, glow: 0.75 });
  const looks: Partial<Scene>[] = [
    { zoom: 1.0, cx: 500, cy: 215, glow: 0.2 },
    { zoom: 1.9, cx: 280, cy: 270, glow: 0.8 },
    { zoom: 1.6, cx: 700, cy: 190, glow: 0.3 },
    { zoom: 2.2, cx: 740, cy: 290, glow: 0.7 },
    { zoom: 1.3, cx: 430, cy: 190, glow: 0.5 },
    { zoom: 1.8, cx: 200, cy: 230, glow: 0.15 },
  ];
  const n = slug === 'new-studio' ? 1 : 6;
  for (let i = 0; i < n; i++) {
    await jpg(join(dir, `work-${i + 1}.jpg`), { w: 1200, h: 900, body: cfg.colors[i % cfg.colors.length], accent: cfg.accent, ...looks[i] });
  }
  console.log(`media: ${slug} -> ${dir}`);
}
await writeFile(join(ROOT, 'README.md'), '# tenants\n\nОдна папка = одна студия: `business.json` + `media/`. Команды: см. SETUP.md.\n`_template` копируется командой `pnpm tenant:new`.\n');
