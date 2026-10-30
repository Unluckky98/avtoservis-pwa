// Manual preview: builds against the harness and serves it. `pnpm harness`
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { OWNER_EMAIL, OWNER_ID, OWNER_PASSWORD, createTestDb } from './db';
import { ANON_KEY, startHarness } from './server';

const port = Number(process.env.PORT ?? 4173);
const db = await createTestDb();
const root = join(import.meta.dirname, '..', '..');
execSync('pnpm build', { cwd: root, stdio: 'inherit', env: { ...process.env, VITE_SUPABASE_URL: `http://localhost:${port}`, VITE_SUPABASE_ANON_KEY: ANON_KEY } });
const h = await startHarness({ dbUrl: db.url, distDir: join(root, 'dist'), port, storageDir: mkdtempSync(join(tmpdir(), 'avto-storage-')), users: { [OWNER_EMAIL]: { id: OWNER_ID, password: OWNER_PASSWORD } } });
console.log(`Harness: ${h.url}/s/graphite/  (test data, NOT Supabase)\nOwner: /s/graphite/owner/  ${OWNER_EMAIL} / ${OWNER_PASSWORD}`);
process.on('SIGINT', async () => { await h.close(); await db.drop(); process.exit(0); });
