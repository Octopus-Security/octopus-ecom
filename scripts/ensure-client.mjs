// Builds client/dist if it is missing or older than client/src. Run by `npm start`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'client', 'dist', 'index.html');

function newest(p) {
  let m = 0;
  let st;
  try { st = fs.statSync(p); } catch { return 0; }
  if (!st.isDirectory()) return st.mtimeMs;
  for (const e of fs.readdirSync(p)) m = Math.max(m, newest(path.join(p, e)));
  return m;
}

const srcTime = Math.max(newest(path.join(root, 'client', 'src')), newest(path.join(root, 'client', 'index.html')), newest(path.join(root, 'client', 'vite.config.mjs')));
let distTime = 0;
try { distTime = fs.statSync(dist).mtimeMs; } catch { /* missing */ }

if (distTime >= srcTime && distTime > 0) process.exit(0);

const vite = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
if (!fs.existsSync(vite)) {
  console.warn('[ensure-client] vite is not installed; run `npm install`. Starting the API without the panel.');
  process.exit(0);
}
console.log('[ensure-client] building the panel...');
const r = spawnSync(process.execPath, [vite, 'build', '--config', path.join(root, 'client', 'vite.config.mjs')], { cwd: root, stdio: 'inherit' });
if (r.status !== 0) console.warn('[ensure-client] panel build failed; starting the API anyway.');
