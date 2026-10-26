import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { STAFF_ROLES } from '@sapientum/contracts/staff';
import {
  AppointFirstAdministrator,
  PostgresStaffStore,
  StaffAccess,
  StaffError,
  StaffService,
  createStaffRoutes,
} from '../src/modules/staff/index.js';
import type { StaffPermission, StaffTransaction } from '../src/modules/staff/index.js';
import { testSchema } from './database.js';

const migration = readFileSync(new URL('../../migrations/001-staff.sql', import.meta.url), 'utf8');
const runtime = { newId: randomUUID, now: () => new Date().toISOString() };
const accounts = { exists: async (id: string) => ['admin', 'alice', 'bob'].includes(id) };

async function fixture(t: TestContext) {
  const { database, open } = await testSchema(t, migration);
  const store = new PostgresStaffStore(database);
  const service = new StaffService(store, accounts, runtime);
  const bootstrap = new AppointFirstAdministrator(store, accounts, runtime);
  const admin = await bootstrap.execute({ tournamentId: 't1', userId: 'admin', actorId: 'owner' });
  const allows = (tournamentId: string, userId: string, permission: StaffPermission) =>
    store.run(({ members }) => new StaffAccess(members).allows(tournamentId, userId, permission));
  return { database, open, store, service, bootstrap, admin, allows };
}

function isError(code: StaffError['code']) {
  return (error: unknown) => error instanceof StaffError && error.code === code;
}

test('all roles are independent, deduplicated, and snapshots cannot be mutated', async (t) => {
  const { service, allows } = await fixture(t);
  const alice = await service.add({
    actorId: 'admin',
    tournamentId: 't1',
    userId: 'alice',
    roles: [...STAFF_ROLES, 'jury'],
  });
  assert.equal(alice.roles.length, 5);
  assert.throws(() => (alice.roles as string[]).push('jury'), TypeError);
  const bob = await service.add({ actorId: 'admin', tournamentId: 't1', userId: 'bob', roles: ['organizer'] });
  assert.equal(await allows('t1', bob.userId, 'tournament.manage'), true);
  assert.equal(await allows('t1', bob.userId, 'staff.manage'), false);
  assert.equal(await allows('t1', bob.userId, 'reviews.check'), false);
});

test('addition rejects missing accounts, invalid roles and duplicate membership', async (t) => {
  const { service } = await fixture(t);
  const input = { actorId: 'admin', tournamentId: 't1', userId: 'alice', roles: ['jury'] };
  await assert.rejects(service.add({ ...input, userId: 'missing' }), isError('USER_NOT_FOUND'));
  await assert.rejects(service.add({ ...input, roles: ['superadmin'] }), isError('INVALID_INPUT'));
  await assert.rejects(service.add({ ...input, roles: 'jury' }), isError('INVALID_INPUT'));
  await service.add(input);
  await assert.rejects(service.add(input), isError('DUPLICATE_MEMBER'));
  assert.equal((await service.list({ actorId: 'admin', tournamentId: 't1', status: 'active' })).length, 2);
});

test('excluded members retain history and immediately lose all permissions', async (t) => {
  const { service, allows } = await fixture(t);
  const alice = await service.add({
    actorId: 'admin',
    tournamentId: 't1',
    userId: 'alice',
    roles: ['jury', 'administrator'],
  });
  const excluded = await service.exclude({
    actorId: 'admin',
    tournamentId: 't1',
    memberId: alice.id,
    expectedVersion: 1,
  });
  assert.deepEqual(excluded.roles, alice.roles);
  assert.equal(excluded.excludedBy, 'admin');
  assert.ok(excluded.excludedAt);
  assert.equal(await allows('t1', 'alice', 'reviews.check'), false);
  await assert.rejects(service.list({ actorId: 'alice', tournamentId: 't1', status: 'active' }), isError('FORBIDDEN'));
  assert.equal((await service.list({ actorId: 'admin', tournamentId: 't1', status: 'excluded' }))[0]?.id, alice.id);
  for (const expectedVersion of [1, 2]) {
    await assert.rejects(
      service.setRoles({ actorId: 'admin', tournamentId: 't1', memberId: alice.id, roles: ['jury'], expectedVersion }),
      isError('MEMBER_EXCLUDED'),
    );
  }
  await assert.rejects(
    service.add({ actorId: 'admin', tournamentId: 't1', userId: 'alice', roles: [] }),
    isError('DUPLICATE_MEMBER'),
  );
});

test('the last administrator cannot be excluded or have the role removed', async (t) => {
  const { service, admin } = await fixture(t);
  const input = { actorId: 'admin', tournamentId: 't1', memberId: admin.id, expectedVersion: 1 };
  await assert.rejects(service.exclude(input), isError('LAST_ADMINISTRATOR'));
  await assert.rejects(service.setRoles({ ...input, roles: ['organizer'] }), isError('LAST_ADMINISTRATOR'));
  const bob = await service.add({ actorId: 'admin', tournamentId: 't1', userId: 'bob', roles: ['administrator'] });
  await service.setRoles({ ...input, roles: ['organizer'] });
  await assert.rejects(
    service.add({ actorId: 'admin', tournamentId: 't1', userId: 'alice', roles: [] }),
    isError('FORBIDDEN'),
  );
  await assert.rejects(
    service.exclude({ actorId: 'bob', tournamentId: 't1', memberId: bob.id, expectedVersion: 1 }),
    isError('LAST_ADMINISTRATOR'),
  );
});

test('membership and permissions are scoped to the tournament', async (t) => {
  const { service, bootstrap, allows } = await fixture(t);
  await bootstrap.execute({ tournamentId: 't2', userId: 'bob', actorId: 'owner' });
  const alice = await service.add({ actorId: 'bob', tournamentId: 't2', userId: 'alice', roles: ['jury'] });
  await assert.rejects(service.list({ actorId: 'admin', tournamentId: 't2', status: 'active' }), isError('FORBIDDEN'));
  await assert.rejects(
    service.exclude({ actorId: 'admin', tournamentId: 't1', memberId: alice.id, expectedVersion: 1 }),
    isError('NOT_FOUND'),
  );
  assert.equal(await allows('t1', 'alice', 'reviews.check'), false);
});

test('stale edits are rejected instead of overwriting newer roles', async (t) => {
  const { service, store } = await fixture(t);
  const alice = await service.add({ actorId: 'admin', tournamentId: 't1', userId: 'alice', roles: ['jury'] });
  const input = { actorId: 'admin', tournamentId: 't1', memberId: alice.id, expectedVersion: 1 };
  assert.equal((await service.setRoles({ ...input, roles: ['author'] })).version, 2);
  await assert.rejects(service.exclude(input), isError('VERSION_CONFLICT'));
  await assert.rejects(service.setRoles({ ...input, roles: ['jury'] }), isError('VERSION_CONFLICT'));
  const stored = await store.run(({ members }) => members.findById('t1', alice.id));
  assert.deepEqual(stored?.snapshot().roles, ['author']);
});

test('a stale write is rejected by the storage as well', async (t) => {
  const { service, store } = await fixture(t);
  await assert.rejects(
    store.run(async ({ members }) => {
      const admin = await members.findByUser('t1', 'admin');
      await members.update(admin!, 99);
    }),
    isError('VERSION_CONFLICT'),
  );
  assert.equal((await service.list({ actorId: 'admin', tournamentId: 't1', status: 'active' }))[0]?.version, 1);
});

test('audit failure rolls back the membership change', async (t) => {
  const { store, service } = await fixture(t);
  const failing: StaffTransaction = {
    run: (operation) =>
      store.run(({ members }) =>
        operation({
          members,
          audit: {
            append: async () => {
              throw new Error('audit unavailable');
            },
          },
        }),
      ),
  };
  const brokenService = new StaffService(failing, accounts, runtime);
  await assert.rejects(
    brokenService.add({ actorId: 'admin', tournamentId: 't1', userId: 'alice', roles: ['jury'] }),
    /audit unavailable/,
  );
  assert.equal((await service.list({ actorId: 'admin', tournamentId: 't1', status: 'active' })).length, 1);
});

test('initial provisioning needs an account and an empty committee', async (t) => {
  const { bootstrap } = await fixture(t);
  await assert.rejects(
    bootstrap.execute({ tournamentId: 't1', userId: 'bob', actorId: 'owner' }),
    isError('ALREADY_INITIALIZED'),
  );
  await assert.rejects(
    bootstrap.execute({ tournamentId: 't2', userId: 'missing', actorId: 'owner' }),
    isError('USER_NOT_FOUND'),
  );
});

test('HTTP adapter validates requests and trusts only the authenticated principal', async (t) => {
  const { service } = await fixture(t);
  const route = createStaffRoutes(service);
  const base = { method: 'POST', url: '/tournaments/t1/staff', principal: { userId: 'admin' } };
  assert.equal((await route({ ...base, principal: null, body: { actorId: 'admin' } })).status, 401);
  const forged = await route({ ...base, principal: { userId: 'alice' }, body: { actorId: 'admin', userId: 'bob' } });
  assert.equal(forged.status, 403);
  assert.equal((await route({ ...base, body: { userId: 'alice', roles: ['unknown'] } })).status, 400);
  const added = await route({ ...base, body: { userId: 'alice', roles: ['jury'] } });
  assert.equal(added.status, 201);
  const member = added.body as { id: string };
  const roles = await route({
    ...base,
    method: 'PUT',
    url: `/tournaments/t1/staff/${member.id}/roles`,
    body: { roles: ['author'], expectedVersion: 1 },
  });
  assert.equal(roles.status, 200);
  const exclude = (expectedVersion: number) =>
    route({ ...base, url: `/tournaments/t1/staff/${member.id}/exclude`, body: { expectedVersion } });
  assert.equal((await exclude(1)).status, 409);
  assert.equal((await exclude(2)).status, 200);
  assert.equal((await route({ ...base, method: 'GET', url: '/tournaments/t1/staff?status=excluded' })).status, 200);
  assert.equal((await route({ ...base, method: 'GET', url: '/tournaments/t1/staff?status=invalid' })).status, 400);
  assert.equal((await route({ ...base, url: '/tournaments/%ZZ/staff' })).status, 400);
});

test('HTTP adapter rejects malformed requests and unknown routes', async (t) => {
  const { service, admin } = await fixture(t);
  const route = createStaffRoutes(service);
  const principal = { userId: 'admin' };
  const post = async (url: string, body: unknown) => (await route({ method: 'POST', url, body, principal })).status;
  for (const body of [undefined, null, [], 'alice']) assert.equal(await post('/tournaments/t1/staff', body), 400);
  for (const userId of [undefined, 42, '', '   ', 'x'.repeat(201)]) {
    assert.equal(await post('/tournaments/t1/staff', { userId, roles: [] }), 400);
  }
  for (const expectedVersion of [undefined, '1', 1.5, 0]) {
    assert.equal(await post(`/tournaments/t1/staff/${admin.id}/exclude`, { expectedVersion }), 400);
  }
  assert.deepEqual(await route({ method: 'GET', url: '/tournaments/t1/staff', principal }), {
    status: 200,
    body: [admin],
  });
  const status = async (method: string, url: string) => (await route({ method, url, principal })).status;
  assert.equal(await status('GET', '/tournaments/t1/teams'), 404);
  assert.equal(await status('GET', `/tournaments/t1/staff/${admin.id}`), 405);
  assert.equal(await status('PUT', `/tournaments/t1/staff/${admin.id}/exclude`), 405);
  assert.equal(await status('DELETE', '/tournaments/t1/staff'), 405);
});

test('HTTP adapter passes unexpected storage errors to the host server', async (t) => {
  const { service, database } = await fixture(t);
  await database.migrate('DROP TABLE staff_audit, staff_members');
  const route = createStaffRoutes(service);
  await assert.rejects(route({ method: 'GET', url: '/tournaments/t1/staff', principal: { userId: 'admin' } }));
});

test('data and audit persist after reopening the database', async (t) => {
  const { service, open } = await fixture(t);
  const alice = await service.add({ actorId: 'admin', tournamentId: 't1', userId: 'alice', roles: ['jury'] });
  await service.setRoles({
    actorId: 'admin',
    tournamentId: 't1',
    memberId: alice.id,
    roles: ['author'],
    expectedVersion: 1,
  });
  await service.exclude({ actorId: 'admin', tournamentId: 't1', memberId: alice.id, expectedVersion: 2 });
  const reopened = open();
  const service2 = new StaffService(new PostgresStaffStore(reopened), accounts, runtime);
  assert.equal((await service2.list({ actorId: 'admin', tournamentId: 't1', status: 'active' })).length, 1);
  assert.equal((await service2.list({ actorId: 'admin', tournamentId: 't1', status: 'excluded' }))[0]?.version, 3);
  const audit = await reopened.transaction(
    async (sql) => (await sql.query('SELECT * FROM staff_audit ORDER BY at')).rows,
  );
  assert.deepEqual(
    audit.map((entry) => entry.action),
    ['first-administrator-appointed', 'member-added', 'roles-assigned', 'member-excluded'],
  );
  const assigned = audit[2];
  assert.equal(assigned.actor_id, 'admin');
  assert.equal(assigned.member_id, alice.id);
  assert.deepEqual(assigned.before_snapshot.roles, ['jury']);
  assert.deepEqual(assigned.after_snapshot.roles, ['author']);
  assert.equal(audit[0].before_snapshot, null);
});

function meetingPoint(parties: number) {
  let arrived = 0;
  let release!: () => void;
  const everyone = new Promise<void>((resolve) => (release = resolve));
  return async () => {
    arrived += 1;
    if (arrived === parties) release();
    await Promise.race([everyone, delay(300)]);
  };
}

function pausedAfterCounting(store: StaffTransaction, wait: () => Promise<void>): StaffTransaction {
  return {
    run: (operation) =>
      store.run((context) => {
        const members = Object.create(context.members);
        members.countAdministrators = async (tournamentId: string) => {
          const count = await context.members.countAdministrators(tournamentId);
          await wait();
          return count;
        };
        return operation({ ...context, members });
      }),
  };
}

test('concurrent exclusions through independent connections retain one administrator', async (t) => {
  const { service, admin, open, store } = await fixture(t);
  const bob = await service.add({ actorId: 'admin', tournamentId: 't1', userId: 'bob', roles: ['administrator'] });
  const wait = meetingPoint(2);
  const first = new StaffService(pausedAfterCounting(store, wait), accounts, runtime);
  const second = new StaffService(pausedAfterCounting(new PostgresStaffStore(open()), wait), accounts, runtime);
  const outcomes = await Promise.allSettled([
    first.exclude({ actorId: 'admin', tournamentId: 't1', memberId: bob.id, expectedVersion: 1 }),
    second.exclude({ actorId: 'bob', tournamentId: 't1', memberId: admin.id, expectedVersion: 1 }),
  ]);
  const results = outcomes.map((outcome) =>
    outcome.status === 'fulfilled' ? 'ok' : outcome.reason instanceof StaffError ? outcome.reason.code : 'other',
  );
  assert.deepEqual(results.sort(), ['FORBIDDEN', 'ok']);
  assert.equal(await store.run(({ members }) => members.countAdministrators('t1')), 1);
});
