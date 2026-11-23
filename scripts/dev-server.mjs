import { createServer } from 'node:http';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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

// Local manual-check host. Dedicated demo database, loopback binding, no production startup path.
const root = fileURLToPath(new URL('../', import.meta.url));
const cachedImage = spawnSync('docker', ['image', 'inspect', 'postgres:16'], { stdio: 'ignore' }).status === 0;
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
    ...(cachedImage ? ['--pull', 'never'] : []),
  ],
  { cwd: root, stdio: 'inherit' },
);
if (docker.status !== 0)
  throw new Error('Demo database startup failed. Check Docker Desktop and the Docker error above.');
const database = new PostgresDatabase({
  connectionString: 'postgres://postgres:postgres@127.0.0.1:55433/sapientum_demo',
});
for (const migration of ['001-staff.sql', '002-teams.sql', '003-sessions.sql']) {
  await database.migrate(await readFile(new URL(`../apps/api/migrations/${migration}`, import.meta.url), 'utf8'));
}
await database.migrate(`CREATE TABLE IF NOT EXISTS demo_accounts (id TEXT PRIMARY KEY, salt TEXT NOT NULL, password_hash TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS demo_tournaments (id TEXT PRIMARY KEY, registration_open BOOLEAN NOT NULL);
  INSERT INTO demo_tournaments VALUES ('demo', true) ON CONFLICT DO NOTHING;`);
await database.transaction(async (sql) => {
  for (const id of ['organizer', 'leader', 'jury']) {
    const salt = randomBytes(16).toString('hex');
    await sql.query('INSERT INTO demo_accounts VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [
      id,
      salt,
      scryptSync('demo12345', salt, 32).toString('hex'),
    ]);
  }
});
const accounts = {
  exists: (id) =>
    database.transaction(
      async (sql) => (await sql.query('SELECT 1 FROM demo_accounts WHERE id=$1', [id])).rowCount === 1,
    ),
};
const credentials = {
  verify: (login, password) =>
    database.transaction(async (sql) => {
      const { rows } = await sql.query('SELECT * FROM demo_accounts WHERE id=$1', [login]);
      const row = rows[0];
      const digest = scryptSync(password, row?.salt ?? 'missing-account', 32);
      return row && timingSafeEqual(digest, Buffer.from(row.password_hash, 'hex')) ? row.id : null;
    }),
};
const runtime = { newId: randomUUID, now: () => new Date().toISOString() };
const staffStore = new PostgresStaffStore(database);
const staff = new StaffService(staffStore, accounts, runtime);
const empty = await staffStore.run(async ({ members }) => (await members.countMembers('demo')) === 0);
if (empty) {
  await new AppointFirstAdministrator(staffStore, accounts, runtime).execute({
    tournamentId: 'demo',
    userId: 'organizer',
    actorId: 'demo-owner',
  });
  await staff.add({ tournamentId: 'demo', actorId: 'organizer', userId: 'jury', roles: ['jury'] });
}
const sessions = new SessionService(
  new PostgresSessionStore(database, (sql) => ({
    isEnabled: async (id) => (await sql.query('SELECT 1 FROM demo_accounts WHERE id=$1', [id])).rowCount === 1,
  })),
  credentials,
  new JoseAccessTokens(randomBytes(32), 'sapientum-demo', 'sapientum-demo'),
  secureSessionRuntime,
);
const teams = new TeamService(
  new PostgresTeamStore(database, (sql) => ({
    accounts: {
      exists: async (id) => (await sql.query('SELECT 1 FROM demo_accounts WHERE id=$1', [id])).rowCount === 1,
    },
    tournaments: {
      registration: async (id) => {
        const { rows } = await sql.query('SELECT registration_open FROM demo_tournaments WHERE id=$1 FOR SHARE', [id]);
        return rows[0] ? { open: rows[0].registration_open } : null;
      },
    },
  })),
  runtime,
);
const authRoutes = createSessionRoutes(sessions);
const teamRoutes = withSessionAuthentication(sessions, createTeamRoutes(teams));
const staffRoutes = withSessionAuthentication(sessions, createStaffRoutes(staff));
const origin = 'http://127.0.0.1:3000';
const csrf = randomBytes(32).toString('hex');
const page = await readFile(new URL('./manual-check.html', import.meta.url));

const server = createServer(async (request, response) => {
  const send = (status, body) => {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(body));
  };
  try {
    if (request.headers.host !== '127.0.0.1:3000') return send(403, { code: 'INVALID_HOST' });
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
    let raw = '';
    for await (const chunk of request) {
      raw += chunk.toString('utf8');
      if (Buffer.byteLength(raw) > 16384) return send(413, { code: 'BODY_TOO_LARGE' });
    }
    let body;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      return send(400, { code: 'INVALID_JSON' });
    }
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
    if (error instanceof SessionError && error.code === 'UNAUTHENTICATED') return send(401, { code: error.code });
    if (error.code === 'FORBIDDEN') return send(403, { code: error.code });
    console.error(error);
    send(500, { code: 'INTERNAL_ERROR' });
  }
});
server.listen(3000, '127.0.0.1', () =>
  console.log(
    `\nOpen ${origin}\nDemo accounts: organizer / leader / jury; password: demo12345\nCtrl+C stops the server. Demo data is retained.`,
  ),
);
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
