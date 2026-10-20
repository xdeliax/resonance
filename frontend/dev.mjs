import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const python = path.join(root, 'backend', '.venv', 'bin', 'python');
const children = [
  spawn(python, ['backend/server.py'], { cwd: root, stdio: 'inherit' }),
  spawn(process.execPath, [path.join(here, 'node_modules/vite/bin/vite.js')], { cwd: here, stdio: 'inherit' }),
];
let stopping = false;

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 300);
}

for (const child of children) {
  child.on('error', (error) => {
    console.error(`Could not start a Resonance local service: ${error.message}`);
    if (error.code === 'ENOENT') console.error('Set up backend/.venv with the commands in backend/README.md, then run npm run dev again.');
    stop(1);
  });
  child.on('exit', (code) => {
    if (!stopping) stop(code ?? 1);
  });
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
