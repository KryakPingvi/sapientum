import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const cached = spawnSync('docker', ['image', 'inspect', 'postgres:16'], { stdio: 'ignore' }).status === 0;
const docker = spawnSync(
  'docker',
  [
    'compose',
    '-p',
    'sapientum-demo',
    '-f',
    'infra/compose.dev.yaml',
    'up',
    '-d',
    '--wait',
    ...(cached ? ['--pull', 'never'] : []),
  ],
  { cwd: root, stdio: 'inherit' },
);
if (docker.status !== 0) throw new Error('Check Docker Desktop and the Docker error above.');
const env = {
  ...process.env,
  DEMO_SERVICE_KEY: randomBytes(32).toString('hex'),
  DEMO_JWT_KEY_BASE64: randomBytes(32).toString('base64'),
};
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  process.exitCode = code;
}
const start = (role) => {
  const child = spawn(process.execPath, ['scripts/dev-service.mjs', role], { cwd: root, env, stdio: 'inherit' });
  children.push(child);
  child.on('exit', (code, signal) => {
    if (!stopping) {
      console.error(`${role} stopped (${code ?? signal})`);
      stop(code || 1);
    }
  });
};
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop());
start('auth');
let ready = false;
for (let i = 0; i < 100 && !stopping; i++) {
  try {
    const response = await fetch('http://127.0.0.1:3001/internal/account', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Service-Key': env.DEMO_SERVICE_KEY },
      body: JSON.stringify({ id: 'organizer' }),
      signal: AbortSignal.timeout(500),
    });
    if (response.ok) {
      ready = true;
      break;
    }
  } catch {
    /* Wait for the independent identity process. */
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
}
if (!ready) {
  stop(1);
  throw new Error('Identity service did not start');
}
start('tournament');
console.log('Open http://127.0.0.1:3000 - organizer / leader / jury, password demo12345. Ctrl+C stops both processes.');
