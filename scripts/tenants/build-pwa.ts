import { join } from 'node:path';
import { ROOT } from './lib.js';
import { buildAll } from './pwa.js';

const dist = join(ROOT, process.env.DIST_DIR ?? 'dist');
const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const built = await buildAll(dist, only);
console.log(`Студии собраны (оболочка, manifest, иконки, worker): ${built.join(', ')}`);
