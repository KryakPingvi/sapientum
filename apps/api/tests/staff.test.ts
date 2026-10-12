import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { STAFF_ROLES } from '@sapientum/contracts/staff';
import { AppointFirstAdministrator, SqliteStaffStore, StaffAccess, StaffError, StaffService, createStaffRoutes } from '../src/modules/staff/index.js';
import type { StaffTransaction } from '../src/modules/staff/application/ports.js';

const migration = readFileSync(new URL('../../migrations/001-staff.sql', import.meta.url), 'utf8');
const runtime = { newId: randomUUID, now: () => new Date().toISOString() };
const accounts = { exists: (id: string) => ['admin', 'alice', 'bob'].includes(id) };

function fixture(path = ':memory:') {
  const store = new SqliteStaffStore(path);
  store.migrate(migration);
  const service = new StaffService(store, accounts, runtime);
  const bootstrap = new AppointFirstAdministrator(store, accounts, runtime);
  const admin = bootstrap.execute({ tournamentId: 't1', userId: 'admin', actorId: 'owner' });
  return { store, service, bootstrap, admin };
}

function isError(code: StaffError['code']) {
  return (error: unknown) => error instanceof StaffError && error.code === code;
}

test('all roles are independent, deduplicated, and snapshots cannot be mutated', () => {
  const { store, service } = fixture();
  try {
    const alice = service.add({ actorId: 'admin', tournamentId: 't1', userId: 'alice', roles: [...STAFF_ROLES, 'jury'] });
    assert.equal(alice.roles.length, 5);
    assert.throws(() => (alice.roles as string[]).push('jury'), TypeError);
    const bob = service.add({ actorId: 'admin', tournamentId: 't1', userId: 'bob', roles: ['organizer'] });
    store.run(({ members }) => {
      const access = new StaffAccess(members);
      assert.equal(access.allows('t1', bob.userId, 'tournament.manage'), true);
      assert.equal(access.allows('t1', bob.userId, 'staff.manage'), false);
      assert.equal(access.allows('t1', bob.userId, 'reviews.check'), false);
    });
  } finally { store.close(); }
});

test('addition rejects missing accounts, invalid roles and duplicate membership', () => {
  const { store, service } = fixture();
  try {
    const input = { actorId: 'admin', tournamentId: 't1', userId: 'alice', roles: ['jury'] };
    assert.throws(() => service.add({ ...input, userId: 'missing' }), isError('USER_NOT_FOUND'));
    assert.throws(() => service.add({ ...input, roles: ['superadmin'] }), isError('INVALID_INPUT'));
    assert.throws(() => service.add({ ...input, roles: 'jury' }), isError('INVALID_INPUT'));
    service.add(input);
    assert.throws(() => service.add(input), isError('DUPLICATE_MEMBER'));
    assert.equal(service.list({ actorId: 'admin', tournamentId: 't1', status: 'active' }).length, 2);
  } finally { store.close(); }
});

test('excluded members retain history and immediately lose all permissions', () => {
  const { store, service } = fixture();
  try {
    const alice = service.add({ actorId: 'admin', tournamentId: 't1', userId: 'alice', roles: ['jury', 'administrator'] });
    const excluded = service.exclude({ actorId: 'admin', tournamentId: 't1', memberId: alice.id, expectedVersion: 1 });
    assert.deepEqual(excluded.roles, alice.roles);
    assert.equal(excluded.excludedBy, 'admin');
    assert.ok(excluded.excludedAt);
    store.run(({ members }) => assert.equal(new StaffAccess(members).allows('t1', 'alice', 'reviews.check'), false));
    assert.throws(() => service.list({ actorId: 'alice', tournamentId: 't1', status: 'active' }), isError('FORBIDDEN'));
    assert.equal(service.list({ actorId: 'admin', tournamentId: 't1', status: 'excluded' })[0]?.id, alice.id);
    assert.throws(() => service.setRoles({ actorId: 'admin', tournamentId: 't1', memberId: alice.id,
      roles: ['jury'], expectedVersion: 2 }), isError('MEMBER_EXCLUDED'));
    assert.throws(() => service.add({ actorId: 'admin', tournamentId: 't1', userId: 'alice', roles: [] }), isError('DUPLICATE_MEMBER'));
  } finally { store.close(); }
});

test('the last administrator cannot be excluded or have the role removed', () => {
  const { store, service, admin } = fixture();
  try {
    const input = { actorId: 'admin', tournamentId: 't1', memberId: admin.id, expectedVersion: 1 };
    assert.throws(() => service.exclude(input), isError('LAST_ADMINISTRATOR'));
    assert.throws(() => service.setRoles({ ...input, roles: ['organizer'] }), isError('LAST_ADMINISTRATOR'));
    const bob = service.add({ actorId: 'admin', tournamentId: 't1', userId: 'bob', roles: ['administrator'] });
    service.setRoles({ ...input, roles: ['organizer'] });
    assert.throws(() => service.add({ actorId: 'admin', tournamentId: 't1', userId: 'alice', roles: [] }), isError('FORBIDDEN'));
    assert.throws(() => service.exclude({ actorId: 'bob', tournamentId: 't1', memberId: bob.id, expectedVersion: 1 }), isError('LAST_ADMINISTRATOR'));
  } finally { store.close(); }
});

test('membership and permissions are scoped to the tournament', () => {
  const { store, service, bootstrap } = fixture();
  try {
    bootstrap.execute({ tournamentId: 't2', userId: 'bob', actorId: 'owner' });
    const alice = service.add({ actorId: 'bob', tournamentId: 't2', userId: 'alice', roles: ['jury'] });
    assert.throws(() => service.list({ actorId: 'admin', tournamentId: 't2', status: 'active' }), isError('FORBIDDEN'));
    assert.throws(() => service.exclude({ actorId: 'admin', tournamentId: 't1', memberId: alice.id, expectedVersion: 1 }), isError('NOT_FOUND'));
    store.run(({ members }) => assert.equal(new StaffAccess(members).allows('t1', 'alice', 'reviews.check'), false));
  } finally { store.close(); }
});

test('stale edits are rejected instead of overwriting newer roles', () => {
  const { store, service } = fixture();
  try {
    const alice = service.add({ actorId: 'admin', tournamentId: 't1', userId: 'alice', roles: ['jury'] });
    const input = { actorId: 'admin', tournamentId: 't1', memberId: alice.id, expectedVersion: 1 };
    assert.equal(service.setRoles({ ...input, roles: ['author'] }).version, 2);
    assert.throws(() => service.exclude(input), isError('VERSION_CONFLICT'));
    assert.throws(() => service.setRoles({ ...input, roles: ['jury'] }), isError('VERSION_CONFLICT'));
    store.run(({ members }) => assert.deepEqual(members.findById('t1', alice.id)?.snapshot().roles, ['author']));
  } finally { store.close(); }
});

test('audit failure rolls back the membership change', () => {
  const { store, service } = fixture();
  try {
    const failing: StaffTransaction = {
      run: operation => store.run(({ members }) => operation({ members, audit: { append: () => { throw new Error('audit unavailable'); } } })),
    };
    const brokenService = new StaffService(failing, accounts, runtime);
    assert.throws(() => brokenService.add({ actorId: 'admin', tournamentId: 't1', userId: 'alice', roles: ['jury'] }), /audit unavailable/);
    assert.equal(service.list({ actorId: 'admin', tournamentId: 't1', status: 'active' }).length, 1);
  } finally { store.close(); }
});

test('initial provisioning is possible only for an empty committee', () => {
  const { store, bootstrap } = fixture();
  try {
    assert.throws(() => bootstrap.execute({ tournamentId: 't1', userId: 'bob', actorId: 'owner' }), isError('ALREADY_INITIALIZED'));
  } finally { store.close(); }
});

test('HTTP adapter validates requests and trusts only the authenticated principal', () => {
  const { store, service } = fixture();
  try {
    const route = createStaffRoutes(service);
    const base = { method: 'POST', url: '/tournaments/t1/staff', principal: { userId: 'admin' } };
    assert.equal(route({ ...base, principal: null, body: { actorId: 'admin' } }).status, 401);
    assert.equal(route({ ...base, principal: { userId: 'alice' }, body: { actorId: 'admin', userId: 'bob', roles: [] } }).status, 403);
    assert.equal(route({ ...base, body: { userId: 'alice', roles: ['unknown'] } }).status, 400);
    const added = route({ ...base, body: { userId: 'alice', roles: ['jury'] } });
    assert.equal(added.status, 201);
    const member = added.body as { id: string };
    assert.equal(route({ ...base, method: 'PUT', url: `/tournaments/t1/staff/${member.id}/roles`,
      body: { roles: ['author'], expectedVersion: 1 } }).status, 200);
    assert.equal(route({ ...base, url: `/tournaments/t1/staff/${member.id}/exclude`, body: { expectedVersion: 1 } }).status, 409);
    assert.equal(route({ ...base, url: `/tournaments/t1/staff/${member.id}/exclude`, body: { expectedVersion: 2 } }).status, 200);
    assert.equal(route({ ...base, method: 'GET', url: '/tournaments/t1/staff?status=excluded' }).status, 200);
    assert.equal(route({ ...base, method: 'GET', url: '/tournaments/t1/staff?status=invalid' }).status, 400);
    assert.equal(route({ ...base, url: '/tournaments/%ZZ/staff' }).status, 400);
  } finally { store.close(); }
});

test('data and audit persist after reopening the database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sapientum-staff-'));
  const path = join(dir, 'staff.sqlite');
  const { store, service } = fixture(path);
  const alice = service.add({ actorId: 'admin', tournamentId: 't1', userId: 'alice', roles: ['jury'] });
  service.setRoles({ actorId: 'admin', tournamentId: 't1', memberId: alice.id, roles: ['author'], expectedVersion: 1 });
  service.exclude({ actorId: 'admin', tournamentId: 't1', memberId: alice.id, expectedVersion: 2 });
  store.close();
  const reopened = new SqliteStaffStore(path);
  try {
    const service2 = new StaffService(reopened, accounts, runtime);
    assert.equal(service2.list({ actorId: 'admin', tournamentId: 't1', status: 'active' }).length, 1);
    assert.equal(service2.list({ actorId: 'admin', tournamentId: 't1', status: 'excluded' })[0]?.version, 3);
    // Audit is deliberately inspected through a separate connection, not the domain API.
    const db = new DatabaseSync(path);
    try {
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM staff_audit').get()?.count, 4);
      const entry = db.prepare("SELECT * FROM staff_audit WHERE action = 'roles-assigned'").get()!;
      assert.equal(entry.actor_id, 'admin');
      assert.equal(entry.member_id, alice.id);
      assert.deepEqual(JSON.parse(String(entry.before_snapshot)).roles, ['jury']);
      assert.deepEqual(JSON.parse(String(entry.after_snapshot)).roles, ['author']);
      assert.ok(entry.at);
    }
    finally { db.close(); }
  } finally { reopened.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('concurrent exclusions through independent connections retain one administrator', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sapientum-staff-race-'));
  const path = join(dir, 'staff.sqlite');
  const { store, service, admin } = fixture(path);
  const bob = service.add({ actorId: 'admin', tournamentId: 't1', userId: 'bob', roles: ['administrator'] });
  store.close();
  const workers: Worker[] = [];
  try {
    const outcomes = [admin, bob].map(member => {
      const worker = new Worker(new URL('./staff-concurrency-worker.js', import.meta.url), {
        workerData: { path, actorId: member.userId, memberId: member.id },
      });
      workers.push(worker);
      let start!: () => void;
      const ready = new Promise<void>(resolve => { start = resolve; });
      const result = new Promise<string>((resolve, reject) => {
        worker.on('message', message => { if (message === 'ready') start(); else resolve(String(message)); });
        worker.on('error', error => { start(); reject(error); });
        worker.on('exit', code => { if (code !== 0) { start(); reject(new Error(`Worker exited with ${code}`)); } });
      });
      return { ready, result, worker };
    });
    await Promise.all(outcomes.map(outcome => outcome.ready));
    for (const outcome of outcomes) outcome.worker.postMessage('start');
    assert.deepEqual((await Promise.all(outcomes.map(outcome => outcome.result))).sort(), ['LAST_ADMINISTRATOR', 'ok']);
    const reopened = new SqliteStaffStore(path);
    try { reopened.run(({ members }) => assert.equal(members.countAdministrators('t1'), 1)); }
    finally { reopened.close(); }
  } finally {
    await Promise.all(workers.map(worker => worker.terminate()));
    rmSync(dir, { recursive: true, force: true });
  }
});
