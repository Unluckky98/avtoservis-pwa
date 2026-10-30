import { execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OWNER_EMAIL, OWNER_ID, OWNER_PASSWORD, createTestDb } from '../harness/db';
import { ANON_KEY, startHarness } from '../harness/server';

const PORT = 4180;
const ROOT = join(import.meta.dirname, '..', '..');

/** Real Postgres + real migrations + a production build of the app, served by the test harness. */
export default async function setup() {
  const db = await createTestDb();
  execSync('pnpm build', { cwd: ROOT, stdio: 'ignore', env: { ...process.env, VITE_SUPABASE_URL: `http://localhost:${PORT}`, VITE_SUPABASE_ANON_KEY: ANON_KEY } });
  const h = await startHarness({
    dbUrl: db.url, distDir: join(ROOT, 'dist'), port: PORT, storageDir: mkdtempSync(join(tmpdir(), 'avto-e2e-')),
    users: { [OWNER_EMAIL]: { id: OWNER_ID, password: OWNER_PASSWORD } },
  });
  return async () => {
    await h.close();
    await db.drop();
  };
}
