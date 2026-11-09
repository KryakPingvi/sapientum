import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { SignJWT, decodeJwt, type JWTPayload } from 'jose';
import {
  SessionService,
  SessionError,
  JoseAccessTokens,
  PostgresSessionStore,
  secureSessionRuntime,
  DEFAULT_SESSION_POLICY,
  createSessionRoutes,
  withSessionAuthentication,
} from '../src/modules/auth/index.js';
import type { SessionPolicy, SessionTransaction, SessionHttpRequest } from '../src/modules/auth/index.js';
import {
  AppointFirstAdministrator,
  PostgresStaffStore,
  StaffService,
  createStaffRoutes,
} from '../src/modules/staff/index.js';
import { testSchema } from './database.js';

const migration = readFileSync(new URL('../../migrations/003-sessions.sql', import.meta.url), 'utf8');
const staffMigration = readFileSync(new URL('../../migrations/001-staff.sql', import.meta.url), 'utf8');
const input = { login: 'alice', password: ' password ', deviceLabel: 'Phone', userAgent: 'Browser', ip: '127.0.0.1' };
const denied = (error: unknown) => error instanceof SessionError && error.code === 'UNAUTHENTICATED';
const invalid = (error: unknown) => error instanceof SessionError && error.code === 'INVALID_INPUT';

async function fixture(t: TestContext, policy: SessionPolicy = DEFAULT_SESSION_POLICY) {
  const { database, open } = await testSchema(t, migration, staffMigration);
  let time = Date.parse('2026-11-09T12:00:00.000Z');
  const clock = { ...secureSessionRuntime, now: () => new Date(time) };
  const enabled = new Set(['alice', 'bob']);
  const accounts = () => ({ isEnabled: async (id: string) => enabled.has(id) });
  const credentials = {
    verify: async (login: string, password: string) =>
      ['alice', 'bob'].includes(login) && password === input.password ? login : null,
  };
  const key = randomBytes(32);
  const tokens = new JoseAccessTokens(key, 'sapientum', 'sapientum-api');
  const store = new PostgresSessionStore(database, accounts);
  const service = new SessionService(store, credentials, tokens, clock, policy);
  const second = () =>
    new SessionService(new PostgresSessionStore(open(), accounts), credentials, tokens, clock, policy);
  return {
    database,
    open,
    service,
    second,
    store,
    credentials,
    tokens,
    key,
    clock,
    enabled,
    tick: (seconds: number) => {
      time += seconds * 1000;
    },
    routes: createSessionRoutes(service),
  };
}

test('login creates independent persistent device sessions without JWT roles or raw stored refresh tokens', async (t) => {
  const { service, database, second } = await fixture(t);
  const phone = await service.login(input);
  const desktop = await service.login({ ...input, deviceLabel: 'Desktop' });
  assert.notEqual(phone.sessionId, desktop.sessionId);
  assert.notEqual(phone.refreshToken, desktop.refreshToken);
  assert.notEqual(phone.accessToken, desktop.accessToken);
  const claims = decodeJwt(phone.accessToken);
  assert.equal(claims.sub, 'alice');
  assert.equal(claims.sid, phone.sessionId);
  assert.equal(claims.roles, undefined);
  assert.equal(claims.exp! - claims.iat!, 900);
  const sessions = await second().list(phone.accessToken);
  assert.equal(sessions.length, 2);
  assert.equal(sessions.filter((s) => s.current).length, 1);
  assert.ok(sessions.every((s) => s.state === 'active' && s.userAgent === 'Browser'));
  await database.transaction(async (sql) => {
    const { rows } = await sql.query<{ digest: string }>('SELECT digest FROM auth_refresh_tokens');
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => /^[a-f0-9]{64}$/.test(row.digest) && row.digest !== phone.refreshToken));
  });
  await assert.rejects(service.login({ ...input, password: 'password' }), denied);
  await assert.rejects(service.login({ ...input, login: 'missing' }), denied);
});

test('revoking one device rejects its existing access and refresh tokens while other devices keep working', async (t) => {
  const { service, second } = await fixture(t);
  const phone = await service.login(input);
  const desktop = await service.login(input);
  await service.revoke(desktop.accessToken, phone.sessionId);
  await assert.rejects(second().authenticate(phone.accessToken), denied);
  await assert.rejects(service.refresh(phone.refreshToken), denied);
  assert.equal((await service.authenticate(desktop.accessToken)).userId, 'alice');
  const revoked = (await service.list(desktop.accessToken)).find((s) => s.id === phone.sessionId)!;
  assert.equal(revoked.state, 'revoked');
  assert.ok(revoked.revokedAt);
  await service.revoke(desktop.accessToken, phone.sessionId);
  assert.equal(
    (await service.list(desktop.accessToken)).find((s) => s.id === phone.sessionId)!.revokedAt,
    revoked.revokedAt,
  );
  await service.revoke(desktop.accessToken, desktop.sessionId);
  await assert.rejects(service.authenticate(desktop.accessToken), denied);
});

test('sessions are private to their account and logout all closes every own device', async (t) => {
  const { service } = await fixture(t);
  const alice = await service.login(input);
  const anotherAlice = await service.login(input);
  const bob = await service.login({ ...input, login: 'bob' });
  assert.equal((await service.list(bob.accessToken)).length, 1);
  for (const id of ['missing', bob.sessionId]) {
    await assert.rejects(
      service.revoke(alice.accessToken, id),
      (error: unknown) => error instanceof SessionError && error.code === 'NOT_FOUND',
    );
  }
  await service.revoke(alice.accessToken, null);
  for (const grant of [alice, anotherAlice]) {
    await assert.rejects(service.authenticate(grant.accessToken), denied);
    await assert.rejects(service.refresh(grant.refreshToken), denied);
  }
  assert.equal((await service.authenticate(bob.accessToken)).userId, 'bob');
});

test('refresh rotates tokens and a replay commits revocation of the whole token family', async (t) => {
  const { service, second, tick } = await fixture(t);
  const initial = await service.login(input);
  tick(1);
  const rotated = await second().refresh(initial.refreshToken);
  assert.equal(rotated.sessionId, initial.sessionId);
  assert.notEqual(rotated.refreshToken, initial.refreshToken);
  assert.equal((await service.authenticate(initial.accessToken)).userId, 'alice');
  await assert.rejects(service.refresh(initial.refreshToken), denied);
  await assert.rejects(second().authenticate(rotated.accessToken), denied);
  await assert.rejects(service.refresh(rotated.refreshToken), denied);
  for (const bad of [null, '', 'invalid', 'a'.repeat(43)]) await assert.rejects(service.refresh(bad), denied);
});

test('concurrent refreshes cannot both consume one token and replay revocation survives the error', async (t) => {
  const { service, second } = await fixture(t);
  const grant = await service.login(input);
  const results = await Promise.allSettled([service.refresh(grant.refreshToken), second().refresh(grant.refreshToken)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter((r) => r.status === 'rejected' && denied(r.reason)).length, 1);
  const winner = results.find((r) => r.status === 'fulfilled')!;
  assert.ok(winner.status === 'fulfilled');
  await assert.rejects(service.authenticate(winner.value.accessToken), denied);
});

test('concurrent refresh and logout cannot resurrect a closed session', async (t) => {
  const { service, second } = await fixture(t);
  const device = await service.login(input);
  const controller = await service.login(input);
  const results = await Promise.allSettled([
    second().refresh(device.refreshToken),
    service.revoke(controller.accessToken, device.sessionId),
  ]);
  assert.equal(results[1]!.status, 'fulfilled');
  await assert.rejects(service.authenticate(device.accessToken), denied);
  if (results[0]!.status === 'fulfilled') await assert.rejects(service.refresh(results[0]!.value.refreshToken), denied);
});

test('two own devices revoking each other serialize without deadlocking', async (t) => {
  const { service, second } = await fixture(t);
  const phone = await service.login(input);
  const desktop = await service.login(input);
  const results = await Promise.allSettled([
    service.revoke(phone.accessToken, desktop.sessionId),
    second().revoke(desktop.accessToken, phone.sessionId),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter((r) => r.status === 'rejected' && denied(r.reason)).length, 1);
});

test('signing failure rolls back session creation and consumption of the refresh token', async (t) => {
  const { service, store, credentials, tokens, clock } = await fixture(t);
  const broken = new SessionService(
    store,
    credentials,
    {
      verify: tokens.verify.bind(tokens),
      issue: async () => {
        throw new Error('signer unavailable');
      },
    },
    clock,
  );
  await assert.rejects(broken.login(input), /signer unavailable/);
  assert.equal((await store.run(({ sessions }) => sessions.list('alice'))).length, 0);
  const original = await service.login(input);
  await assert.rejects(broken.refresh(original.refreshToken), /signer unavailable/);
  const refreshed = await service.refresh(original.refreshToken);
  assert.equal((await service.authenticate(refreshed.accessToken)).sessionId, original.sessionId);
});

test('access expiry is independent from idle and absolute session deadlines', async (t) => {
  const { service, tick } = await fixture(t, { accessSeconds: 10, idleSeconds: 20, absoluteSeconds: 30 });
  const initial = await service.login(input);
  tick(10);
  await assert.rejects(service.authenticate(initial.accessToken), denied);
  const next = await service.refresh(initial.refreshToken);
  tick(9);
  await service.authenticate(next.accessToken);
  tick(1);
  const capped = await service.refresh(next.refreshToken);
  assert.equal(capped.expiresAt, '2026-11-09T12:00:30.000Z');
  assert.equal(capped.refreshExpiresAt, capped.expiresAt);
  tick(10);
  await assert.rejects(service.refresh(capped.refreshToken), denied);
  const fresh = await service.login(input);
  assert.equal((await service.list(fresh.accessToken)).find((s) => s.id === initial.sessionId)!.state, 'expired');
});

test('idle sessions, expired refresh tokens and disabled accounts cannot regain access', async (t) => {
  const { service, tick, enabled, database } = await fixture(t, {
    accessSeconds: 5,
    idleSeconds: 10,
    absoluteSeconds: 50,
  });
  const idle = await service.login(input);
  tick(10);
  await assert.rejects(service.refresh(idle.refreshToken), denied);
  const expiredToken = await service.login(input);
  await database.transaction((sql) =>
    sql.query('UPDATE auth_refresh_tokens SET expires_at = $1 WHERE session_id = $2', [
      '2026-11-09T12:00:00Z',
      expiredToken.sessionId,
    ]),
  );
  await assert.rejects(service.refresh(expiredToken.refreshToken), denied);
  const active = await service.login(input);
  enabled.delete('alice');
  await assert.rejects(service.authenticate(active.accessToken), denied);
  await assert.rejects(service.refresh(active.refreshToken), denied);
  await assert.rejects(service.login(input), denied);
});

test('JWT checks reject wrong signatures, claims, audience, issuer, type and nonexistent sessions', async (t) => {
  const { service, key, clock, tokens } = await fixture(t);
  const grant = await service.login(input);
  await assert.rejects(
    new JoseAccessTokens(randomBytes(32), 'sapientum', 'sapientum-api').verify(grant.accessToken, clock.now()),
    denied,
  );
  for (const issuer of ['other'])
    await assert.rejects(
      new JoseAccessTokens(key, issuer, 'sapientum-api').verify(grant.accessToken, clock.now()),
      denied,
    );
  await assert.rejects(new JoseAccessTokens(key, 'sapientum', 'other').verify(grant.accessToken, clock.now()), denied);
  await assert.rejects(service.authenticate('malformed'), denied);
  const base = {
    sub: 'alice',
    sid: grant.sessionId,
    iat: Math.floor(clock.now().getTime() / 1000),
    exp: Math.floor(clock.now().getTime() / 1000) + 100,
    iss: 'sapientum',
    aud: 'sapientum-api',
    jti: 'id',
  };
  for (const claims of [
    { ...base, sub: '' },
    { ...base, sub: 123 },
    { ...base, sid: '' },
    { ...base, sid: 123 },
    { ...base, iat: base.iat + 100 },
    { ...base, jti: '' },
    { ...base, jti: 123 },
    { ...base, iat: 'bad' },
    { ...base, sid: undefined },
  ]) {
    const signed = await new SignJWT(claims as unknown as JWTPayload)
      .setProtectedHeader({ alg: 'HS256', typ: 'at+jwt' })
      .sign(key);
    await assert.rejects(service.authenticate(signed), denied);
  }
  const wrongType = await new SignJWT(base).setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).sign(key);
  await assert.rejects(service.authenticate(wrongType), denied);
  const missing = await tokens.issue(
    { userId: 'alice', sessionId: 'missing' },
    clock.now(),
    new Date(clock.now().getTime() + 10000),
  );
  await assert.rejects(service.authenticate(missing), denied);
  const impostor = await tokens.issue(
    { userId: 'bob', sessionId: grant.sessionId },
    clock.now(),
    new Date(clock.now().getTime() + 10000),
  );
  await assert.rejects(service.authenticate(impostor), denied);
});

test('session policies, key configuration and login metadata are validated', async (t) => {
  const { service, store, credentials, tokens, clock } = await fixture(t);
  for (const policy of [
    { accessSeconds: 0, idleSeconds: 20, absoluteSeconds: 30 },
    { accessSeconds: 1.1, idleSeconds: 20, absoluteSeconds: 30 },
    { accessSeconds: 3601, idleSeconds: 4000, absoluteSeconds: 5000 },
    { accessSeconds: 10, idleSeconds: 9, absoluteSeconds: 30 },
    { accessSeconds: 10, idleSeconds: 20, absoluteSeconds: 19 },
    { accessSeconds: 10, idleSeconds: 20, absoluteSeconds: 400 * 86400 },
  ])
    assert.throws(() => new SessionService(store, credentials, tokens, clock, policy), invalid);
  for (const config of [
    [new Uint8Array(31), 'iss', 'aud'],
    [randomBytes(32), '', 'aud'],
    [randomBytes(32), 'iss', ''],
  ] as const)
    assert.throws(() => new JoseAccessTokens(config[0], config[1], config[2]), invalid);
  for (const field of ['login', 'deviceLabel', 'userAgent', 'ip'] as const) {
    for (const value of [null, '', ' ', 'a\0b', 'x'.repeat(1025)])
      await assert.rejects(service.login({ ...input, [field]: value }), invalid);
  }
  for (const password of [null, '', 'x'.repeat(1025)])
    await assert.rejects(service.login({ ...input, password }), invalid);
  const grant = await service.login(input);
  await assert.rejects(service.revoke(grant.accessToken, ''), invalid);
});

test('removing tournament rights affects every device without expiring their JWTs or account sessions', async (t) => {
  const { service, database } = await fixture(t);
  const staffStore = new PostgresStaffStore(database);
  const accounts = { exists: async () => true };
  const staffRuntime = { newId: secureSessionRuntime.newId, now: () => new Date().toISOString() };
  const member = await new AppointFirstAdministrator(staffStore, accounts, staffRuntime).execute({
    tournamentId: 't1',
    userId: 'alice',
    actorId: 'owner',
  });
  const staff = new StaffService(staffStore, accounts, staffRuntime);
  await staff.add({ actorId: 'alice', tournamentId: 't1', userId: 'bob', roles: ['administrator'] });
  const phone = await service.login(input);
  const desktop = await service.login(input);
  const route = createStaffRoutes(staff);
  const protectedRoute = withSessionAuthentication(service, route);
  const request = async (access: string) =>
    protectedRoute({ method: 'GET', url: '/tournaments/t1/staff', accessToken: access });
  assert.equal((await request(phone.accessToken)).status, 200);
  await staff.exclude({ actorId: 'bob', tournamentId: 't1', memberId: member.id, expectedVersion: 1 });
  assert.equal((await request(phone.accessToken)).status, 403);
  assert.equal((await request(desktop.accessToken)).status, 403);
  assert.equal((await service.list(phone.accessToken)).length, 2);
  assert.equal((await request('')).status, 401);
  assert.equal((await request('malformed')).status, 401);
  await service.revoke(desktop.accessToken, phone.sessionId);
  assert.equal((await request(phone.accessToken)).status, 401);
});

const request: SessionHttpRequest = {
  method: 'POST',
  url: '/auth/login',
  accessToken: '',
  refreshToken: '',
  csrfVerified: true,
  userAgent: 'Browser',
  ip: '127.0.0.1',
  body: input,
};

test('session HTTP uses host cookies, CSRF checks and verified tokens rather than body identity', async (t) => {
  const { routes, service } = await fixture(t);
  const login = await routes(request);
  assert.equal(login.status, 200);
  assert.ok(login.refreshCookie?.value);
  assert.equal(login.headers['Cache-Control'], 'no-store');
  assert.equal((login.body as Record<string, unknown>).refreshToken, undefined);
  const accessToken = (login.body as { accessToken: string }).accessToken;
  assert.equal((await routes({ ...request, url: '/auth/sessions', method: 'GET', accessToken })).status, 200);
  const refreshed = await routes({ ...request, url: '/auth/refresh', refreshToken: login.refreshCookie!.value });
  assert.equal(refreshed.status, 200);
  const other = await service.login(input);
  assert.equal(
    (
      await routes({
        ...request,
        url: `/auth/sessions/${other.sessionId}`,
        method: 'DELETE',
        accessToken,
        body: { userId: 'bob' },
      })
    ).status,
    204,
  );
  await assert.rejects(service.authenticate(other.accessToken), denied);
  const logout = await routes({ ...request, url: '/auth/sessions', method: 'DELETE', accessToken });
  assert.equal(logout.status, 204);
  assert.equal(logout.refreshCookie, null);
});

test('session HTTP rejects invalid routes, methods, input and CSRF, and preserves server failures', async (t) => {
  const { routes, store, tokens, clock, service, credentials } = await fixture(t);
  assert.equal((await routes({ ...request, csrfVerified: false })).status, 403);
  assert.equal((await routes({ ...request, url: '/register' })).status, 404);
  assert.equal((await routes({ ...request, url: '/auth/login/id' })).status, 404);
  assert.equal((await routes({ ...request, method: 'GET' })).status, 405);
  assert.equal((await routes({ ...request, url: '/auth/sessions/id', method: 'GET' })).status, 405);
  assert.equal((await routes({ ...request, url: '/auth/sessions/%XX', method: 'DELETE' })).status, 400);
  for (const body of [null, [], 'text', {}, undefined]) assert.equal((await routes({ ...request, body })).status, 400);
  assert.equal((await routes({ ...request, body: { ...input, password: 'wrong' } })).status, 401);
  assert.equal((await routes({ ...request, url: '/auth/sessions', method: 'GET' })).status, 401);
  const fail: SessionTransaction = {
    run: async () => {
      throw new Error('database unavailable');
    },
  };
  const broken = createSessionRoutes(new SessionService(fail, { verify: async () => 'alice' }, tokens, clock));
  await assert.rejects(broken(request), /database unavailable/);
  const badCredentials = createSessionRoutes(
    new SessionService(
      store,
      {
        verify: async () => {
          throw new Error('account service unavailable');
        },
      },
      tokens,
      clock,
    ),
  );
  await assert.rejects(badCredentials(request), /account service unavailable/);
  const grant = await service.login(input);
  const brokenAuthentication = withSessionAuthentication(
    new SessionService(fail, credentials, tokens, clock),
    async () => ({ status: 200, body: null }),
  );
  await assert.rejects(
    brokenAuthentication({ method: 'GET', url: '/anything', accessToken: grant.accessToken }),
    /database unavailable/,
  );
  const invalidCodec = {
    issue: tokens.issue.bind(tokens),
    verify: async () => {
      throw new SessionError('INVALID_INPUT', 'codec configuration');
    },
  };
  await assert.rejects(
    withSessionAuthentication(new SessionService(store, credentials, invalidCodec, clock), async () => ({
      status: 200,
      body: null,
    }))({ method: 'GET', url: '/', accessToken: grant.accessToken }),
    /codec configuration/,
  );
});

test('production clock and cryptographic runtime round trip with a copied signing key', async (t) => {
  const { store, credentials } = await fixture(t);
  const key = randomBytes(32);
  const tokens = new JoseAccessTokens(key, 'sapientum', 'sapientum-api');
  key.fill(0);
  const service = new SessionService(store, credentials, tokens, secureSessionRuntime);
  const grant = await service.login(input);
  assert.equal((await service.authenticate(grant.accessToken)).userId, 'alice');
  const current = (await service.list(grant.accessToken))[0]!;
  assert.equal(Date.parse(current.expiresAt) - Date.parse(current.createdAt), 30 * 86400 * 1000);
  assert.equal(Date.parse(grant.expiresAt) - Date.parse(current.createdAt), 900000);
});
