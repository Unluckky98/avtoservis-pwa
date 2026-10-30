import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { renderSeed } from '../../scripts/tenants/lib';

const ROOT = join(import.meta.dirname, '..', '..');
export const OWNER_ID = '11111111-1111-4111-8111-111111111111';
export const OWNER_EMAIL = 'owner@graphite.test';
export const OWNER_PASSWORD = 'harness-pass-1';

/** Fresh database with the Supabase stand-in roles, every real migration and the demo seed. */
export async function createTestDb(adminUrl = process.env.TEST_PG_URL ?? 'postgres://postgres@localhost:54329/postgres') {
  const dbName = `avto_e2e_${process.pid}_${Date.now()}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`create database ${dbName}`);
  await admin.end();
  const url = new URL(adminUrl);
  url.pathname = `/${dbName}`;
  const db = new pg.Client({ connectionString: url.toString() });
  await db.connect();
  await db.query('create schema if not exists extensions');
  await db.query(readFileSync(join(ROOT, 'supabase/tests/bootstrap.sql'), 'utf8'));
  const dir = join(ROOT, 'supabase/migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await db.query(readFileSync(join(dir, f), 'utf8'));
  await db.query(await renderSeed(['graphite', 'garage47']));
  await db.query(`update tenants set status = 'live' where slug = 'graphite'`); // garage47 stays a labelled sample
  await db.query(`insert into tenant_members (tenant_id, user_id) select id, '${OWNER_ID}' from tenants where slug = 'graphite'`);
  await db.end();
  return {
    url: url.toString(),
    async drop() {
      const a = new pg.Client({ connectionString: adminUrl });
      await a.connect();
      await a.query(`drop database if exists ${dbName} with (force)`);
      await a.end();
    },
  };
}
