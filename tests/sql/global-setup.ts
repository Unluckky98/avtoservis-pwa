import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

/**
 * Creates a fresh database for the run and applies the Supabase stand-in bootstrap
 * (roles + auth.uid) followed by every real migration, in order.
 * TEST_PG_URL must point at a PostgreSQL 16+ server with btree_gist and pgcrypto,
 * using a role that may create databases.
 */
const ROOT = join(import.meta.dirname, '..', '..');

export default async function setup() {
  const adminUrl = process.env.TEST_PG_URL ?? 'postgres://postgres@localhost:54329/postgres';
  const dbName = `avto_test_${process.pid}_${Date.now()}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`create database ${dbName}`);
  await admin.end();

  const url = new URL(adminUrl);
  url.pathname = `/${dbName}`;
  process.env.TEST_DB_URL = url.toString();

  const db = new pg.Client({ connectionString: url.toString() });
  await db.connect();
  await db.query('create schema if not exists extensions');
  await db.query(readFileSync(join(ROOT, 'supabase/tests/bootstrap.sql'), 'utf8'));
  const dir = join(ROOT, 'supabase/migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    await db.query(readFileSync(join(dir, f), 'utf8'));
  }
  await db.end();

  return async () => {
    const a = new pg.Client({ connectionString: adminUrl });
    await a.connect();
    await a.query(`drop database if exists ${dbName} with (force)`);
    await a.end();
  };
}
