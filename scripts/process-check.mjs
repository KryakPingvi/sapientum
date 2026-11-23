import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
const env = {
  ...process.env,
  DEMO_SERVICE_KEY: randomBytes(32).toString('hex'),
  DEMO_JWT_KEY_BASE64: randomBytes(32).toString('base64'),
};
const children = [];
function start(role, port) {
  const child = spawn(process.execPath, ['scripts/dev-service.mjs', role], {
    env: { ...env, DEMO_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (data) => {
    output += data;
  });
  child.stderr.on('data', (data) => {
    output += data;
  });
  children.push(child);
  child.on('error', (error) => console.error(error.message));
  return { child, output: () => output };
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode) return;
  const ended = new Promise((resolve) => child.once('exit', resolve));
  child.kill();
  await ended;
}
async function ready(instance, url, options) {
  for (let i = 0; i < 80; i++) {
    if (instance.child.exitCode !== null) throw new Error(instance.output());
    try {
      if ((await fetch(url, { ...options, signal: AbortSignal.timeout(500) })).ok) return;
    } catch {
      /* Startup. */
    }
    await delay(100);
  }
  throw new Error('Process not ready: ' + instance.output());
}
const origins = ['http://127.0.0.1:3000', 'http://127.0.0.1:3002'];
const contexts = [];
async function call(index, path, method = 'GET', body, token = '') {
  const origin = origins[index];
  const response = await fetch(origin + path, {
    method,
    headers: {
      Origin: origin,
      'X-CSRF-Token': contexts[index]?.csrf ?? '',
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10000),
  });
  return { status: response.status, body: response.status === 204 ? null : await response.json() };
}
let adminToken, restoreMember;
let lockerReady = false;
const locker = new pg.Client({ connectionString: 'postgres://postgres:postgres@127.0.0.1:55435/sapientum_tournament' });
const monitor = new pg.Client({
  connectionString: 'postgres://postgres:postgres@127.0.0.1:55435/sapientum_tournament',
});
try {
  let auth = start('auth', 3001);
  const authOptions = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Service-Key': env.DEMO_SERVICE_KEY },
    body: JSON.stringify({ id: 'organizer' }),
  };
  await ready(auth, 'http://127.0.0.1:3001/internal/account', authOptions);
  assert.equal((await fetch('http://127.0.0.1:3001/internal/account', { method: 'POST' })).status, 403);
  for (let i = 0; i < 2; i++) {
    const core = start('tournament', i === 0 ? 3000 : 3002);
    await ready(core, origins[i] + '/dev/context');
    contexts[i] = (await call(i, '/dev/context')).body;
  }
  const login = await call(0, '/auth/login', 'POST', {
    login: 'organizer',
    password: 'demo12345',
    deviceLabel: 'Process check',
  });
  assert.equal(login.status, 200);
  adminToken = login.body.accessToken;
  assert.equal((await call(1, '/dev/registration', 'POST', { open: true }, adminToken)).status, 200);
  const created = await call(
    0,
    '/tournaments/demo/teams',
    'POST',
    { name: `Process ${randomUUID()}`, organization: 'Check', leaderName: 'Check' },
    adminToken,
  );
  assert.equal(created.status, 201);
  const other = await call(
    0,
    '/tournaments/demo/teams',
    'POST',
    { name: `Process ${randomUUID()}`, organization: 'Check', leaderName: 'Check' },
    adminToken,
  );
  const member = (await call(0, '/tournaments/demo/staff', 'GET', undefined, adminToken)).body.find(
    (item) => item.userId === 'organizer',
  );
  assert.ok(member.roles.includes('administrator') && member.roles.includes('organizer'));
  await locker.connect();
  lockerReady = true;
  await monitor.connect();
  await locker.query('BEGIN');
  await locker.query('SELECT id FROM teams WHERE id=$1 FOR UPDATE', [created.body.id]);
  const confirmation = call(0, `/tournaments/demo/teams/${created.body.id}/confirm`, 'POST', {}, adminToken);
  async function waitLock(granted, mode) {
    for (let i = 0; i < 100; i++) {
      const { rows } = await monitor.query(
        "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=hashtext('staff')::oid AND objid=hashtext('demo')::oid AND granted=$1 AND mode=$2) AS present",
        [granted, mode],
      );
      if (rows[0].present) return;
      await delay(20);
    }
    throw new Error('Expected lock not observed: ' + mode);
  }
  await waitLock(true, 'ShareLock');
  const revocation = call(
    1,
    `/tournaments/demo/staff/${member.id}/roles`,
    'PUT',
    { roles: ['administrator'], expectedVersion: member.version },
    adminToken,
  );
  await waitLock(false, 'ExclusiveLock');
  await locker.query('COMMIT');
  assert.equal((await confirmation).status, 200);
  const revoked = await revocation;
  assert.equal(revoked.status, 200);
  restoreMember = revoked.body;
  assert.equal((await call(0, `/tournaments/demo/teams/${other.body.id}/confirm`, 'POST', {}, adminToken)).status, 403);
  assert.equal((await call(1, `/tournaments/demo/teams/${other.body.id}/confirm`, 'POST', {}, adminToken)).status, 403);
  assert.equal(
    (
      await call(
        1,
        `/tournaments/demo/staff/${member.id}/roles`,
        'PUT',
        { roles: member.roles, expectedVersion: revoked.body.version },
        adminToken,
      )
    ).status,
    200,
  );
  restoreMember = null;
  await stop(auth.child);
  assert.equal((await call(1, '/tournaments/demo/teams')).status, 200);
  assert.equal((await call(0, '/auth/sessions', 'GET', undefined, adminToken)).status, 503);
  auth = start('auth', 3001);
  await ready(auth, 'http://127.0.0.1:3001/internal/account', authOptions);
  assert.equal((await call(1, '/auth/sessions', 'GET', undefined, adminToken)).status, 200);
  assert.equal((await call(0, `/auth/sessions/${login.body.sessionId}`, 'DELETE', undefined, adminToken)).status, 204);
  assert.equal((await call(1, '/auth/sessions', 'GET', undefined, adminToken)).status, 401);
  const { rows } = await monitor.query(
    "SELECT to_regclass('auth_sessions') AS sessions, to_regclass('demo_accounts') AS accounts",
  );
  assert.equal(rows[0].sessions, null);
  assert.equal(rows[0].accounts, null);
  console.log(
    'Process checks passed: two tournament replicas, role revocation ordering, identity failure/restart, cross-replica logout, isolated data owners.',
  );
  for (const urls of [origins.slice(0, 1), origins]) {
    const load = spawn(process.execPath, ['scripts/load-tournament.mjs'], {
      env: { ...process.env, LOAD_URLS: urls.join(',') },
      stdio: 'inherit',
    });
    const code = await new Promise((resolve) => load.once('exit', resolve));
    assert.equal(code, 0);
  }
} finally {
  if (lockerReady) await locker.query('ROLLBACK').catch(() => {});
  if (restoreMember && adminToken)
    await call(
      1,
      `/tournaments/demo/staff/${restoreMember.id}/roles`,
      'PUT',
      { roles: ['administrator', 'organizer'], expectedVersion: restoreMember.version },
      adminToken,
    ).catch(() => {});
  await Promise.all([locker.end(), monitor.end()]);
  await Promise.all(children.map(stop));
}
