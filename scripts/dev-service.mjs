import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { passwordDigest, loginGuard, readJson } from './dev-security.mjs';
import { readFile } from 'node:fs/promises';

import { PostgresDatabase } from '../apps/api/dist/src/infrastructure/postgres.js';
import {
  SessionService,
  JoseAccessTokens,
  PostgresSessionStore,
  secureSessionRuntime,
  createSessionRoutes,
  withSessionAuthentication,
  SessionError,
} from '../apps/api/dist/src/modules/auth/index.js';
import {
  StaffService,
  PostgresStaffStore,
  AppointFirstAdministrator,
  createStaffRoutes,
  requirePostgresStaffPermission,
} from '../apps/api/dist/src/modules/staff/index.js';
import { TeamService, PostgresTeamStore, createTeamRoutes } from '../apps/api/dist/src/modules/teams/index.js';

const role = process.argv[2];
if (!['auth', 'tournament'].includes(role)) throw new Error('Choose auth or tournament');
const isAuth = role === 'auth';
const port = Number(process.env.DEMO_PORT ?? (isAuth ? 3001 : 3000));
if (![3000, 3001, 3002].includes(port)) throw new Error('Invalid demo port');
const serviceKey = process.env.DEMO_SERVICE_KEY;
if (!serviceKey || serviceKey.length < 32) throw new Error('DEMO_SERVICE_KEY (32+ characters) is required');
const authOrigin = process.env.DEMO_AUTH_URL ?? 'http://127.0.0.1:3001';
const poolMax = Number(process.env.DEMO_POOL_MAX ?? 10);
if (!Number.isSafeInteger(poolMax) || poolMax < 1 || poolMax > 50) throw new Error('DEMO_POOL_MAX must be 1..50');
async function remote(path, data) {
  try {
    const response = await fetch(authOrigin + '/internal/' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Service-Key': serviceKey },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(1500),
    });
    if (response.status === 401) throw new SessionError('UNAUTHENTICATED', 'Inactive session');
    if (!response.ok) throw new Error('Identity service rejected request');
    return await response.json();
  } catch (error) {
    if (error instanceof SessionError) throw error;
    throw Object.assign(new Error('Identity service unavailable'), { code: 'SERVICE_UNAVAILABLE' });
  }
}
const database = new PostgresDatabase({
  max: poolMax,
  connectionTimeoutMillis: 1000,
  options: '-c statement_timeout=4000 -c lock_timeout=3000',
  connectionString: isAuth
    ? 'postgres://postgres:postgres@127.0.0.1:55434/sapientum_identity'
    : 'postgres://postgres:postgres@127.0.0.1:55435/sapientum_tournament',
});
for (const migration of isAuth
  ? ['003-sessions.sql', '004-session-maintenance.sql']
  : ['001-staff.sql', '002-teams.sql']) {
  await database.migrate(await readFile(new URL(`../apps/api/migrations/${migration}`, import.meta.url), 'utf8'));
}
if (isAuth) {
  await database.migrate(
    `CREATE TABLE IF NOT EXISTS demo_accounts (id TEXT PRIMARY KEY, salt TEXT NOT NULL, password_hash TEXT NOT NULL);
     CREATE TABLE IF NOT EXISTS demo_login_windows (key TEXT PRIMARY KEY, started_at TIMESTAMPTZ NOT NULL, hits INTEGER NOT NULL);`,
  );
  await database.transaction(async (sql) => {
    for (const id of ['organizer', 'leader', 'jury']) {
      const salt = randomBytes(16).toString('hex');
      await sql.query('INSERT INTO demo_accounts VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [
        id,
        salt,
        (await passwordDigest('demo12345', salt)).toString('hex'),
      ]);
    }
  });
} else {
  await database.migrate(
    "CREATE TABLE IF NOT EXISTS demo_tournaments (id TEXT PRIMARY KEY, registration_open BOOLEAN NOT NULL); INSERT INTO demo_tournaments VALUES ('demo', true) ON CONFLICT DO NOTHING;",
  );
}
const accounts = {
  exists: (id) =>
    isAuth
      ? database.transaction(
          async (sql) => (await sql.query('SELECT 1 FROM demo_accounts WHERE id=$1', [id])).rowCount === 1,
        )
      : remote('account', { id }).then((result) => result.exists),
};
const credentials = {
  verify: async (login, password) => {
    const row = await database.transaction(async (sql) => {
      const { rows } = await sql.query('SELECT * FROM demo_accounts WHERE id=$1', [login]);
      return rows[0];
    });
    const digest = await passwordDigest(password, row?.salt ?? 'missing-account');
    return row && timingSafeEqual(digest, Buffer.from(row.password_hash, 'hex')) ? row.id : null;
  },
};
let staff, staffStore;
const runtime = { newId: randomUUID, now: () => new Date().toISOString() };
if (!isAuth) {
  staffStore = new PostgresStaffStore(database);
  staff = new StaffService(staffStore, accounts, runtime);
  const empty = await staffStore.run(async ({ members }) => (await members.countMembers('demo')) === 0);
  if (empty) {
    await new AppointFirstAdministrator(staffStore, accounts, runtime).execute({
      tournamentId: 'demo',
      userId: 'organizer',
      actorId: 'demo-owner',
    });
    await staff.add({ tournamentId: 'demo', actorId: 'organizer', userId: 'jury', roles: ['jury'] });
  }
}
const activity = { sessionRowUpdates: 0 };
const identityStore = isAuth
  ? new PostgresSessionStore(database, (sql) => ({
      isEnabled: async (id) => (await sql.query('SELECT 1 FROM demo_accounts WHERE id=$1', [id])).rowCount === 1,
    }))
  : null;
const observedStore = {
  run: (operation) =>
    identityStore.run((context) =>
      operation({
        ...context,
        sessions: new Proxy(context.sessions, {
          get(target, property) {
            if (property === 'touch')
              return async (...args) => {
                await target.touch(...args);
                activity.sessionRowUpdates++;
              };
            const value = Reflect.get(target, property);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        }),
      }),
    ),
};
const sessions = isAuth
  ? new SessionService(
      observedStore,
      credentials,
      new JoseAccessTokens(
        process.env.DEMO_JWT_KEY_BASE64 ? Buffer.from(process.env.DEMO_JWT_KEY_BASE64, 'base64') : randomBytes(32),
        'sapientum-demo',
        'sapientum-demo',
      ),
      secureSessionRuntime,
    )
  : {
      authenticate: async (accessToken) => {
        const result = await remote('authenticate', { accessToken });
        if (typeof result.userId !== 'string' || typeof result.sessionId !== 'string')
          throw Object.assign(new Error('Invalid identity response'), { code: 'SERVICE_UNAVAILABLE' });
        return result;
      },
    };
const teams = isAuth
  ? null
  : new TeamService(
      new PostgresTeamStore(database, (sql) => ({
        accounts: {
          exists: (id) => accounts.exists(id),
        },
        tournaments: {
          registration: async (id) => {
            const { rows } = await sql.query('SELECT registration_open FROM demo_tournaments WHERE id=$1 FOR SHARE', [
              id,
            ]);
            return rows[0] ? { open: rows[0].registration_open } : null;
          },
        },
      })),
      runtime,
    );
const authRoutes = isAuth ? createSessionRoutes(sessions) : (request) => remote('route', request);
const guardedLogin = loginGuard(database);
const cleanup = isAuth
  ? setInterval(
      () => sessions.purgeEnded().catch((error) => console.error('Session cleanup failed:', error.message)),
      60000,
    )
  : null;
cleanup?.unref();
const teamRoutes = isAuth ? null : withSessionAuthentication(sessions, createTeamRoutes(teams));
const staffRoutes = isAuth ? null : withSessionAuthentication(sessions, createStaffRoutes(staff));
const origin = `http://127.0.0.1:${port}`;
const csrf = randomBytes(32).toString('hex');
const page = await readFile(new URL('./manual-check.html', import.meta.url));

const server = createServer(async (request, response) => {
  const send = (status, body) => {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(body));
  };
  try {
    if (isAuth) {
      const supplied = request.headers['x-service-key'];
      if (
        typeof supplied !== 'string' ||
        Buffer.byteLength(supplied) !== Buffer.byteLength(serviceKey) ||
        !timingSafeEqual(Buffer.from(supplied), Buffer.from(serviceKey))
      )
        return send(403, { code: 'SERVICE_AUTH_REQUIRED' });
      if (request.method !== 'POST') return send(405, { code: 'METHOD_NOT_ALLOWED' });
      const data = await readJson(request);
      if (request.url === '/internal/metrics') return send(200, activity);
      if (request.url === '/internal/authenticate') return send(200, await sessions.authenticate(data.accessToken));
      if (request.url === '/internal/account') return send(200, { exists: await accounts.exists(data.id) });
      if (request.url === '/internal/route')
        return send(
          200,
          new URL(data.url, 'http://localhost').pathname === '/auth/login' && data.method === 'POST'
            ? await guardedLogin(data, () => authRoutes(data))
            : await authRoutes(data),
        );
      return send(404, { code: 'NOT_FOUND' });
    }
    if (request.headers.host !== `127.0.0.1:${port}`) return send(403, { code: 'INVALID_HOST' });
    const path = new URL(request.url, origin).pathname;
    const method = request.method;
    if (method === 'GET' && path === '/') {
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      return response.end(page);
    }
    if (method === 'GET' && path === '/dev/context') {
      const open = await database.transaction(
        async (sql) =>
          (await sql.query("SELECT registration_open FROM demo_tournaments WHERE id='demo'")).rows[0].registration_open,
      );
      return send(200, { csrf, registrationOpen: open });
    }
    const csrfVerified = request.headers.origin === origin && request.headers['x-csrf-token'] === csrf;
    if (!['GET', 'HEAD'].includes(method) && !csrfVerified) return send(403, { code: 'CSRF_REJECTED' });
    const body = await readJson(request);
    const accessToken = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
    let result;
    if (path.startsWith('/auth/')) {
      // HTTP loopback-only cookie deliberately differs from the Secure production cookie contract.
      const refreshToken =
        /(?:^|;\s*)sapientum_demo_refresh=([A-Za-z0-9_-]+)/.exec(request.headers.cookie ?? '')?.[1] ?? '';
      result = await authRoutes({
        method,
        url: request.url,
        body,
        accessToken,
        refreshToken,
        csrfVerified,
        userAgent: request.headers['user-agent'] ?? 'Manual check',
        ip: request.socket.remoteAddress ?? 'loopback',
      });
      if (result.refreshCookie !== undefined) {
        const cookie = result.refreshCookie;
        response.setHeader(
          'Set-Cookie',
          cookie
            ? `sapientum_demo_refresh=${cookie.value}; HttpOnly; SameSite=Strict; Path=/auth; Expires=${new Date(cookie.expiresAt).toUTCString()}`
            : 'sapientum_demo_refresh=; HttpOnly; SameSite=Strict; Path=/auth; Max-Age=0',
        );
      }
    } else if (path === '/dev/registration' && method === 'POST') {
      const principal = await sessions.authenticate(accessToken);
      if (typeof body?.open !== 'boolean') return send(400, { code: 'INVALID_INPUT' });
      await database.transaction(async (sql) => {
        await requirePostgresStaffPermission(sql, 'demo', principal.userId, 'tournament.manage');
        await sql.query("UPDATE demo_tournaments SET registration_open=$1 WHERE id='demo'", [body.open]);
      });
      result = { status: 200, body: { registrationOpen: body.open } };
    } else {
      const route = path.includes('/staff') ? staffRoutes : teamRoutes;
      result = await route({ method, url: request.url, body, accessToken });
    }
    if (result.status === 204) {
      response.writeHead(204, { 'Cache-Control': 'no-store' });
      return response.end();
    }
    return send(result.status, result.body);
  } catch (error) {
    if (error.code === 'INVALID_JSON') return send(400, { code: error.code });
    if (error.code === 'BODY_TOO_LARGE') return send(413, { code: error.code });
    if (error instanceof SessionError && error.code === 'UNAUTHENTICATED') return send(401, { code: error.code });
    if (error.code === 'SERVICE_UNAVAILABLE') return send(503, { code: error.code });
    if (error.code === 'FORBIDDEN') return send(403, { code: error.code });
    console.error(error);
    send(500, { code: 'INTERNAL_ERROR' });
  }
});
server.listen(port, '127.0.0.1', () => console.log(`\n${role} PID=${process.pid} ${origin} ready`));
server.on('error', async (error) => {
  console.error(error.message);
  await database.close();
  process.exitCode = 1;
});
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () =>
    server.close(async () => {
      await database.close();
      process.exit(0);
    }),
  );
