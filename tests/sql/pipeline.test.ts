import { describe, expect, it } from 'vitest';
import { admin, anon, localSlot, owner, rpc, idemKey } from './helpers';
import { publishTenant, plannedMediaUrls, validateTenant, renderSeed, type Exec } from '../../scripts/tenants/lib';
import { verifyDb } from '../../scripts/tenants/verify';
import { businessSchema, type BusinessConfig } from '../../src/shared/business-schema';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const exec: Exec = (sql, params) => admin(sql, params as any[]).then((rows) => ({ rows }));

async function loadCfg(slug = 'graphite'): Promise<BusinessConfig> {
  const v = await validateTenant(slug);
  expect(v.errors).toEqual([]);
  return structuredClone(v.config!);
}
/** Same demo studio under a unique slug, so tests don't collide. */
async function fresh(): Promise<BusinessConfig> {
  const c = await loadCfg();
  c.slug = `p-${randomUUID().slice(0, 10)}`;
  return c;
}
const publish = (c: BusinessConfig) => publishTenant(exec, c, plannedMediaUrls(c));

describe('валидация конфига', () => {
  it('оба демо-студии проходят проверку', async () => {
    for (const s of ['graphite', 'garage47']) expect((await validateTenant(s)).ok).toBe(true);
  });
  it('отклоняет плохой конфиг', async () => {
    const c = await loadCfg();
    const bad = (m: (x: any) => void) => {
      const x = structuredClone(c) as any;
      m(x);
      return businessSchema.safeParse(x).success;
    };
    expect(bad((x) => (x.slug = 'Bad Slug'))).toBe(false);
    expect(bad((x) => (x.accent = 'blue'))).toBe(false);
    expect(bad((x) => (x.timezone = 'Mars/Base'))).toBe(false);
    expect(bad((x) => x.cards.pop())).toBe(false);
    expect(bad((x) => (x.services[0].price = -5))).toBe(false);
    expect(bad((x) => x.services.push({ ...x.services[0] }))).toBe(false);
    expect(bad((x) => (x.services[0].resources = ['нет-такого']))).toBe(false);
    expect(bad(() => {})).toBe(true);
  });
  it('несуществующая студия даёт понятную ошибку', async () => {
    const v = await validateTenant('no-such-studio');
    expect(v.ok).toBe(false);
    expect(v.errors.length).toBeGreaterThan(0);
  });
});

describe('публикация', () => {
  it('создаёт студию как образец и проходит verify из базы', async () => {
    const c = await fresh();
    await publish(c);
    const [t] = await admin(`select status, is_demo from tenants where slug = $1`, [c.slug]);
    expect(t.status).toBe('preview');
    const checks = await verifyDb(exec, c);
    expect(checks.filter((x) => x.status === 'fail')).toEqual([]);
  });

  it('повторная публикация идемпотентна: ничего не дублируется', async () => {
    const c = await fresh();
    await publish(c);
    const count = async () =>
      (await admin(
        `select (select count(*) from services s join tenants t on t.id=s.tenant_id where t.slug=$1)::int svc,
                (select count(*) from resources s join tenants t on t.id=s.tenant_id where t.slug=$1)::int res,
                (select count(*) from gallery_items s join tenants t on t.id=s.tenant_id where t.slug=$1)::int gal,
                (select count(*) from info_cards s join tenants t on t.id=s.tenant_id where t.slug=$1)::int cards,
                (select count(*) from working_hours s join tenants t on t.id=s.tenant_id where t.slug=$1)::int hrs`,
        [c.slug],
      ))[0];
    const a = await count();
    await publish(c);
    await publish(c);
    expect(await count()).toEqual(a);
  });

  it('обновление сохраняет записи, фото владельца и статус live', async () => {
    const c = await fresh();
    await publish(c);
    const [t] = await admin(`select id from tenants where slug = $1`, [c.slug]);
    await admin(`update tenants set status='live' where id=$1`, [t.id]);
    await admin(`insert into gallery_items (tenant_id, image_url, caption, sort, origin) values ($1,'https://x/own.jpg','Своё',99,'owner')`, [t.id]);

    const svc = await rpc<any>(anon('10.1.1.1'), 'studio_public', [c.slug]);
    const first = svc.studio.services[0];
    const start = await localSlot(c.timezone, 2, '12:00');
    const b = await rpc<any>(anon('10.1.1.2'), 'create_booking', [c.slug, first.id, start, 'Иван', '+7 900 111-22-33', 'BMW', idemKey()]);
    expect(b.ok).toBe(true);

    // owner edits config: new price, a service dropped, one added
    c.services[0].price += 100;
    const dropped = c.services.pop()!;
    c.services.push({ ...dropped, key: 'new-one', name: 'Новая услуга' });
    c.services = c.services.filter((s) => s.key !== dropped.key);
    await publish(c);

    const [after] = await admin(`select status, config_version from tenants where id=$1`, [t.id]);
    expect(after.status).toBe('live');
    expect(after.config_version).toBeGreaterThan(1);
    expect((await admin(`select count(*)::int n from bookings where tenant_id=$1`, [t.id]))[0].n).toBe(1);
    expect((await admin(`select count(*)::int n from gallery_items where tenant_id=$1 and origin='owner'`, [t.id]))[0].n).toBe(1);
    // booked service keeps its historical price on the booking
    const [bk] = await admin(`select price_cents from bookings where tenant_id=$1`, [t.id]);
    expect(bk.price_cents).toBe(first.price_cents);
  });

  it('услуга, убранная из конфига, отключается, а не удаляется', async () => {
    const c = await fresh();
    await publish(c);
    const gone = c.services[c.services.length - 1];
    c.services = c.services.slice(0, -1);
    await publish(c);
    const [s] = await admin(
      `select s.active from services s join tenants t on t.id=s.tenant_id where t.slug=$1 and s.config_key=$2`,
      [c.slug, gone.key],
    );
    expect(s.active).toBe(false);
    const pub = await rpc<any>(anon('10.2.2.2'), 'studio_public', [c.slug]);
    // preview studios are visible via studio_public; deactivated service must not be offered
    expect(pub.studio.services.some((x: any) => x.name === gone.name)).toBe(false);
  });

  it('фото из конфига, которого больше нет, удаляется, фото владельца нет', async () => {
    const c = await fresh();
    await publish(c);
    c.gallery = c.gallery.slice(0, 1);
    await publish(c);
    const rows = await admin(
      `select count(*)::int n from gallery_items g join tenants t on t.id=g.tenant_id where t.slug=$1 and origin='config'`,
      [c.slug],
    );
    expect(rows[0].n).toBe(1);
  });

  it('публикация одной студии не затрагивает другую (изоляция tenant_id)', async () => {
    const a = await fresh();
    const b = await fresh();
    await publish(a);
    await publish(b);
    const before = (await admin(`select count(*)::int n from services s join tenants t on t.id=s.tenant_id where t.slug=$1`, [b.slug]))[0].n;
    a.services = a.services.slice(0, 1);
    await publish(a);
    const after = (await admin(`select count(*)::int n from services s join tenants t on t.id=s.tenant_id where t.slug=$1 and s.active`, [b.slug]))[0].n;
    expect(after).toBe(before);
  });

  it('владелец из membership видит свою студию, чужой нет', async () => {
    const c = await fresh();
    await publish(c);
    const [t] = await admin(`select id from tenants where slug=$1`, [c.slug]);
    const uid = randomUUID();
    await admin(`insert into tenant_members (tenant_id, user_id) values ($1,$2)`, [t.id, uid]);
    const ctx = await rpc<any>(owner(uid), 'owner_context', [c.slug]);
    expect(ctx.ok ?? true).toBeTruthy();
    await expect(rpc(owner(randomUUID()), 'owner_context', [c.slug])).rejects.toThrow(/forbidden/);
  });
});

describe('seed.sql', () => {
  it('сгенерированный seed применяется дважды без ошибок и дублей', async () => {
    const sql = await renderSeed(['graphite', 'garage47']);
    await admin(sql);
    const n1 = (await admin(`select count(*)::int n from services s join tenants t on t.id=s.tenant_id where t.slug in ('graphite','garage47')`))[0].n;
    await admin(sql);
    const n2 = (await admin(`select count(*)::int n from services s join tenants t on t.id=s.tenant_id where t.slug in ('graphite','garage47')`))[0].n;
    expect(n2).toBe(n1);
    const rows = await admin(`select slug, status from tenants where slug in ('graphite','garage47') order by slug`);
    expect(rows.every((r) => r.status === 'preview')).toBe(true);
  });
  it('в файле supabase/seed.sql нет секретов', async () => {
    const text = await readFile(join(import.meta.dirname, '../../supabase/seed.sql'), 'utf8');
    expect(text).not.toMatch(/service_role|password|secret/i);
  });
});
