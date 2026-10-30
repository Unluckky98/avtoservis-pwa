import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const walk = (dir: string, out: string[] = []): string[] => {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (n === 'node_modules' || n === 'dist') continue;
    statSync(p).isDirectory() ? walk(p, out) : out.push(p);
  }
  return out;
};
const read = (p: string) => readFileSync(p, 'utf8');
const tenants = readdirSync(join(ROOT, 'tenants')).filter((d) => !d.startsWith('_') && statSync(join(ROOT, 'tenants', d)).isDirectory());

describe('one shared build: no studio is hard-coded', () => {
  const code = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'supabase/functions'))].filter((f) => /\.(tsx?|css|html)$/.test(f) && !/\.test\.ts$/.test(f));

  it('studio names and slugs from tenants/* never appear in src or Edge Functions', () => {
    const names = tenants.flatMap((t) => {
      const cfg = JSON.parse(read(join(ROOT, 'tenants', t, 'business.json')));
      return [cfg.name, t, String(cfg.name).split(/\s+/)[0]];
    });
    for (const f of code) {
      const text = read(f).toLowerCase();
      for (const n of names) expect(text.includes(String(n).toLowerCase()), `${f} mentions "${n}"`).toBe(false);
    }
  });

  it('there is at least one demo studio that differs visibly from another', () => {
    expect(tenants.length).toBeGreaterThanOrEqual(2);
    const cfgs = tenants.map((t) => JSON.parse(read(join(ROOT, 'tenants', t, 'business.json'))));
    expect(new Set(cfgs.map((c) => c.accent)).size).toBe(cfgs.length);
    expect(new Set(cfgs.map((c) => c.resources.length)).size).toBeGreaterThan(1);
  });
});

describe('secrets stay out of the repository and the bundle', () => {
  it('.env.example holds placeholders only', () => {
    const t = read(join(ROOT, '.env.example'));
    for (const line of t.split('\n')) {
      const m = /^([A-Z_]+)=(.*)$/.exec(line);
      if (!m) continue;
      expect(m[2], line).not.toMatch(/^(eyJ|sk-|[A-Za-z0-9+/_-]{40,})/);
    }
  });
  it('service-role and private keys are referenced only by server code', () => {
    for (const f of walk(join(ROOT, 'src'))) {
      if (!/\.(tsx?)$/.test(f)) continue;
      expect(read(f), f).not.toMatch(/SERVICE_ROLE|LLM_API_KEY|VAPID_PRIVATE|DISPATCH_SECRET/);
    }
  });
  it('no .env files are committed', () => {
    const bad = readdirSync(ROOT).filter((n) => /^\.env(\.|$)/.test(n) && n !== '.env.example');
    expect(bad).toEqual([]);
  });
});

describe('database stays the single source for runtime', () => {
  it('the client never reads business.json', () => {
    for (const f of walk(join(ROOT, 'src'))) {
      if (!/\.(tsx?)$/.test(f) || f.includes('shared/business-schema')) continue;
      expect(read(f), f).not.toMatch(/business\.json/);
    }
  });
  it('the service worker never caches API routes', () => {
    const sw = read(join(ROOT, 'src/sw.ts'));
    expect(sw).toMatch(/NEVER = \/\^\\\/\(rest\|auth\|functions/);
  });
});
