import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { AppointFirstAdministrator, PostgresStaffStore, StaffService, StaffError } from '../src/modules/staff/index.js';
import { TeamService, TeamError, PostgresTeamStore, createTeamRoutes } from '../src/modules/teams/index.js';
import type { TeamDependencyFactory, TeamTransaction } from '../src/modules/teams/index.js';
import { Team } from '../src/modules/teams/domain/team.js';
import { testSchema } from './database.js';

const migrations = ['001-staff.sql', '002-teams.sql'].map((name) =>
  readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8'),
);
const runtime = { newId: randomUUID, now: () => new Date().toISOString() };
const accounts = { exists: async (id: string) => ['admin', 'leader', 'alice', 'bob'].includes(id) };
const application = {
  actorId: 'leader',
  tournamentId: 't1',
  name: 'Сапиенты',
  organization: 'Школа 1',
  leaderName: 'Иван Иванов',
};
const isError = (code: TeamError['code']) => (error: unknown) => error instanceof TeamError && error.code === code;
const forbidden = (error: unknown) => error instanceof StaffError && error.code === 'FORBIDDEN';

async function fixture(t: TestContext) {
  const { database, open } = await testSchema(t, ...migrations);
  const registration = new Map([
    ['t1', { open: true }],
    ['t2', { open: true }],
  ]);
  const dependencies: TeamDependencyFactory = () => ({
    accounts,
    tournaments: { registration: async (id) => registration.get(id) ?? null },
  });
  const store = new PostgresTeamStore(database, dependencies);
  const service = new TeamService(store, runtime);
  const staff = new StaffService(new PostgresStaffStore(database), accounts, runtime);
  const bootstrap = new AppointFirstAdministrator(new PostgresStaffStore(database), accounts, runtime);
  const administrator = await bootstrap.execute({ tournamentId: 't1', userId: 'admin', actorId: 'owner' });
  return {
    database,
    open,
    registration,
    dependencies,
    store,
    service,
    staff,
    administrator,
    routes: createTeamRoutes(service),
  };
}

test('team application trims fields, uses the account as leader and persists across connections', async (t) => {
  const { service, open, dependencies } = await fixture(t);
  const team = await service.submit({
    ...application,
    name: ' Сапиенты ',
    organization: ' Школа 1 ',
    leaderName: ' Иван Иванов ',
  });
  assert.equal(team.name, application.name);
  assert.equal(team.organization, application.organization);
  assert.equal(team.leaderName, application.leaderName);
  assert.equal(team.leaderId, 'leader');
  assert.equal(team.status, 'pending');
  assert.equal(team.confirmedAt, null);
  assert.equal(team.confirmedBy, null);
  assert.throws(() => {
    (team as { name: string }).name = 'tampered';
  }, TypeError);
  const restarted = new TeamService(new PostgresTeamStore(open(), dependencies), runtime);
  assert.deepEqual(await restarted.list({ tournamentId: 't1', status: 'all' }), [team]);
  await service.submit({ ...application, name: 'Другая команда' });
  assert.equal((await service.list({ tournamentId: 't1', status: 'all' })).length, 2);
});

test('registration and existing account are required, tournaments remain isolated', async (t) => {
  const { service, registration } = await fixture(t);
  registration.set('t1', { open: false });
  await assert.rejects(service.submit(application), isError('REGISTRATION_CLOSED'));
  await assert.rejects(service.submit({ ...application, tournamentId: 'missing' }), isError('TOURNAMENT_NOT_FOUND'));
  await assert.rejects(service.list({ tournamentId: 'missing', status: 'all' }), isError('TOURNAMENT_NOT_FOUND'));
  await assert.rejects(
    service.submit({ ...application, tournamentId: 't2', actorId: 'missing' }),
    isError('USER_NOT_FOUND'),
  );
  await service.submit({ ...application, tournamentId: 't2' });
  assert.deepEqual(await service.list({ tournamentId: 't1', status: 'all' }), []);
  assert.equal((await service.list({ tournamentId: 't2', status: 'pending' })).length, 1);
});

test('case-insensitive team names are unique per tournament including concurrent applications', async (t) => {
  const { service, open, dependencies } = await fixture(t);
  const other = new TeamService(new PostgresTeamStore(open(), dependencies), runtime);
  const results = await Promise.allSettled([
    service.submit(application),
    other.submit({ ...application, name: ' САПИЕНТЫ ' }),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected');
  assert.ok(rejected?.status === 'rejected' && isError('DUPLICATE_NAME')(rejected.reason));
  assert.equal((await service.list({ tournamentId: 't1', status: 'all' })).length, 1);
  await service.submit({ ...application, tournamentId: 't2' });
});

test('only an active tournament organizer confirms a pending team, even after registration closes', async (t) => {
  const { service, staff, administrator, registration } = await fixture(t);
  const team = await service.submit(application);
  const input = { actorId: 'admin', tournamentId: 't1', teamId: team.id };
  await staff.setRoles({
    actorId: 'admin',
    tournamentId: 't1',
    memberId: administrator.id,
    roles: ['administrator', 'jury', 'author', 'representative'],
    expectedVersion: 1,
  });
  await assert.rejects(service.confirm(input), forbidden);
  const organizer = await staff.add({ actorId: 'admin', tournamentId: 't1', userId: 'alice', roles: ['organizer'] });
  await assert.rejects(service.confirm({ ...input, tournamentId: 't2', actorId: 'alice' }), forbidden);
  await assert.rejects(service.confirm({ ...input, actorId: 'leader' }), forbidden);
  await staff.exclude({ actorId: 'admin', tournamentId: 't1', memberId: organizer.id, expectedVersion: 1 });
  await assert.rejects(service.confirm({ ...input, actorId: 'alice' }), forbidden);
  await staff.add({ actorId: 'admin', tournamentId: 't1', userId: 'bob', roles: ['organizer'] });
  registration.set('t1', { open: false });
  const confirmed = await service.confirm({ ...input, actorId: 'bob' });
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.confirmedBy, 'bob');
  assert.ok(confirmed.confirmedAt);
  assert.deepEqual(await service.list({ tournamentId: 't1', status: 'pending' }), []);
  assert.deepEqual(await service.list({ tournamentId: 't1', status: 'confirmed' }), [confirmed]);
  await assert.rejects(service.confirm({ ...input, actorId: 'bob' }), isError('ALREADY_CONFIRMED'));
});

test('confirmation rejects foreign, absent teams and missing tournaments', async (t) => {
  const { service, registration } = await fixture(t);
  const foreign = await service.submit({ ...application, tournamentId: 't2' });
  for (const teamId of ['missing', foreign.id]) {
    await assert.rejects(service.confirm({ actorId: 'admin', tournamentId: 't1', teamId }), isError('NOT_FOUND'));
  }
  registration.delete('t1');
  await assert.rejects(
    service.confirm({ actorId: 'admin', tournamentId: 't1', teamId: foreign.id }),
    isError('TOURNAMENT_NOT_FOUND'),
  );
});

test('two connections cannot confirm a team twice, storage also rejects stale confirmation', async (t) => {
  const { service, store, open, dependencies } = await fixture(t);
  const team = await service.submit(application);
  const input = { actorId: 'admin', tournamentId: 't1', teamId: team.id };
  const second = new TeamService(new PostgresTeamStore(open(), dependencies), runtime);
  const results = await Promise.allSettled([service.confirm(input), second.confirm(input)]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected');
  assert.ok(rejected?.status === 'rejected' && isError('ALREADY_CONFIRMED')(rejected.reason));
  await assert.rejects(
    store.run(({ teams }) => teams.confirm(Team.restore(team).confirm('admin', runtime.now()))),
    isError('ALREADY_CONFIRMED'),
  );
});

test('organizer exclusion waits for an authorized confirmation transaction to finish', async (t) => {
  const { database, registration, service, staff, store, open } = await fixture(t);
  const tournamentId = `race-${randomUUID()}`;
  registration.set(tournamentId, { open: true });
  await new AppointFirstAdministrator(new PostgresStaffStore(database), accounts, runtime).execute({
    tournamentId,
    userId: 'admin',
    actorId: 'owner',
  });
  const organizer = await staff.add({ actorId: 'admin', tournamentId, userId: 'alice', roles: ['organizer'] });
  const team = await service.submit({ ...application, tournamentId });
  let signalAuthorized!: () => void;
  const authorized = new Promise<void>((resolve) => {
    signalAuthorized = resolve;
  });
  let releaseConfirmation!: () => void;
  const released = new Promise<void>((resolve) => {
    releaseConfirmation = resolve;
  });
  const paused = new TeamService(
    {
      run: (operation) =>
        store.run((context) =>
          operation({
            ...context,
            requireOrganizer: async (id, actor) => {
              await context.requireOrganizer(id, actor);
              signalAuthorized();
              await released;
            },
          }),
        ),
    },
    runtime,
  );
  const confirmation = paused.confirm({ actorId: 'alice', tournamentId, teamId: team.id });
  // Attach handlers before asserting, so an assertion failure can still release and drain both operations.
  const confirmationResult = Promise.allSettled([confirmation]);
  await authorized;
  const otherStaff = new StaffService(new PostgresStaffStore(open()), accounts, runtime);
  const exclusion = otherStaff.exclude({ actorId: 'admin', tournamentId, memberId: organizer.id, expectedVersion: 1 });
  const exclusionResult = Promise.allSettled([exclusion]);
  try {
    let waiting = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      waiting = await database.transaction(async (sql) => {
        const { rows } = await sql.query<{ waiting: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted
           AND classid = hashtext('staff')::oid AND objid = hashtext($1)::oid) AS waiting`,
          [tournamentId],
        );
        return rows[0]!.waiting;
      });
      if (waiting) break;
      await delay(10);
    }
    assert.equal(waiting, true, 'exclusion must wait on the membership lock held by confirmation');
  } finally {
    releaseConfirmation();
    await Promise.all([confirmationResult, exclusionResult]);
  }
  assert.equal((await confirmation).status, 'confirmed');
  assert.equal((await exclusion).status, 'excluded');
  const another = await service.submit({ ...application, tournamentId, name: 'Another' });
  await assert.rejects(service.confirm({ actorId: 'alice', tournamentId, teamId: another.id }), forbidden);
});

test('application rejects invalid fields, identifiers and filters without writing teams', async (t) => {
  const { service } = await fixture(t);
  for (const field of ['name', 'organization', 'leaderName'] as const) {
    const limit = field === 'name' ? 200 : 300;
    for (const value of [undefined, null, 42, [], '', '  ', 'x'.repeat(limit + 1), 'a\0b']) {
      await assert.rejects(service.submit({ ...application, [field]: value }), isError('INVALID_INPUT'));
    }
  }
  for (const value of ['', ' ', 'x'.repeat(201)]) {
    await assert.rejects(service.submit({ ...application, actorId: value }), isError('INVALID_INPUT'));
    await assert.rejects(service.list({ tournamentId: value, status: 'all' }), isError('INVALID_INPUT'));
    await assert.rejects(
      service.confirm({ actorId: 'admin', tournamentId: 't1', teamId: value }),
      isError('INVALID_INPUT'),
    );
  }
  // Direct domain calls enforce the same rules as the HTTP/service entry points.
  assert.throws(
    () => Team.submit({ ...application, id: 3 as unknown as string, leaderId: 'leader', at: runtime.now() }),
    isError('INVALID_INPUT'),
  );
  const domain = Team.submit({ ...application, id: 'id', leaderId: 'leader', at: runtime.now() });
  assert.throws(() => domain.confirm('', runtime.now()), isError('INVALID_INPUT'));
  await assert.rejects(service.list({ tournamentId: 't1', status: 'unknown' }), isError('INVALID_INPUT'));
  assert.deepEqual(await service.list({ tournamentId: 't1', status: 'all' }), []);
});

test('team transaction rolls back failures and does not turn unrelated SQL failures into name conflicts', async (t) => {
  const { database, service, store } = await fixture(t);
  const fixed = new TeamService(store, { ...runtime, newId: () => 'same-id' });
  await fixed.submit(application);
  await assert.rejects(
    fixed.submit({ ...application, name: 'Another' }),
    (error: unknown) => (error as { code: string }).code === '23505',
  );
  await assert.rejects(
    store.run(async ({ teams }) => {
      await teams.insert(
        Team.submit({ ...application, name: 'Rollback', id: 'rollback', leaderId: 'leader', at: runtime.now() }),
      );
      throw new Error('failure after insert');
    }),
    /failure after insert/,
  );
  assert.equal((await service.list({ tournamentId: 't1', status: 'all' })).length, 1);
  // Exercise the non-unique-error path as well as PostgreSQL constraints.
  await database.migrate("ALTER TABLE teams ADD CONSTRAINT reject_insert CHECK (name <> 'Rejected')");
  await assert.rejects(
    service.submit({ ...application, name: 'Rejected' }),
    (error: unknown) => (error as { code: string }).code === '23514',
  );
});

test('public HTTP lists need no session and writes trust only the session principal', async (t) => {
  const { routes } = await fixture(t);
  const base = { url: '/tournaments/t1/teams', principal: null };
  assert.deepEqual(await routes({ ...base, method: 'GET' }), { status: 200, body: [] });
  assert.equal((await routes({ ...base, method: 'POST', body: application })).status, 401);
  const response = await routes({
    ...base,
    method: 'POST',
    principal: { userId: 'leader' },
    body: { ...application, actorId: 'admin', leaderId: 'admin' },
  });
  assert.equal(response.status, 201);
  const team = response.body as { id: string; leaderId: string };
  assert.equal(team.leaderId, 'leader');
  const confirm = { method: 'POST', url: `/tournaments/t1/teams/${team.id}/confirm`, principal: null };
  assert.equal((await routes(confirm)).status, 401);
  assert.equal((await routes({ ...confirm, principal: { userId: 'leader' }, body: { actorId: 'admin' } })).status, 403);
  assert.equal((await routes({ ...confirm, principal: { userId: 'admin' } })).status, 200);
  assert.equal((await routes({ ...confirm, principal: { userId: 'admin' } })).status, 409);
  const list = await routes({ ...base, url: `${base.url}?status=confirmed`, method: 'GET' });
  assert.equal((list.body as unknown[]).length, 1);
});

test('HTTP adapter returns validation and domain errors and rethrows infrastructure failures', async (t) => {
  const { routes, registration } = await fixture(t);
  const base = { method: 'POST', url: '/tournaments/t1/teams', principal: { userId: 'leader' }, body: application };
  for (const body of [undefined, null, [], 'text', 42, {}, { ...application, name: '' }]) {
    assert.equal((await routes({ ...base, body })).status, 400);
  }
  for (const url of ['/tournaments/%XX/teams', '/tournaments/t1/teams/%XX/confirm', '/tournaments/%20/teams']) {
    assert.equal((await routes({ ...base, url })).status, 400);
  }
  assert.equal((await routes({ ...base, url: '/other' })).status, 404);
  assert.equal((await routes({ ...base, method: 'PUT' })).status, 405);
  assert.equal((await routes({ ...base, method: 'GET', url: '/tournaments/t1/teams/id/confirm' })).status, 405);
  assert.equal((await routes({ ...base, method: 'GET', url: `${base.url}?status=invalid` })).status, 400);
  assert.equal((await routes({ ...base, principal: { userId: 'missing' } })).status, 404);
  assert.equal((await routes({ ...base, url: '/tournaments/missing/teams' })).status, 404);
  registration.set('t1', { open: false });
  assert.equal((await routes(base)).status, 409);
  const fail: TeamTransaction = {
    run: async () => {
      throw new Error('database unavailable');
    },
  };
  await assert.rejects(createTeamRoutes(new TeamService(fail, runtime))(base), /database unavailable/);
  // A staff infrastructure error other than FORBIDDEN must not be disguised as a denial.
  const badStaff: TeamTransaction = {
    run: async () => {
      throw new StaffError('INVALID_INPUT', 'broken integration');
    },
  };
  await assert.rejects(createTeamRoutes(new TeamService(badStaff, runtime))(base), /broken integration/);
});
