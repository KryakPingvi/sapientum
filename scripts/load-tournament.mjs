import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { setTimeout as delay } from 'node:timers/promises';
const origins = (process.env.LOAD_URLS ?? 'http://127.0.0.1:3000').split(',');
const count = Number(process.env.LOAD_COUNT ?? 30),
  concurrency = Number(process.env.LOAD_CONCURRENCY ?? 6);
if (
  !Number.isInteger(count) ||
  count < 1 ||
  count > 1000 ||
  !Number.isInteger(concurrency) ||
  concurrency < 1 ||
  concurrency > 50 ||
  origins.some((url) => !/^http:\/\/127\.0\.0\.1:300[02]$/.test(url))
)
  throw new Error('Use loopback URLs, count 1..1000 and concurrency 1..50');
const contexts = await Promise.all(
  origins.map(async (origin) => ({ origin, csrf: (await (await fetch(origin + '/dev/context')).json()).csrf })),
);
async function call(index, path, body, token = '') {
  const ctx = contexts[index % contexts.length];
  const result = await fetch(ctx.origin + path, {
    method: 'POST',
    headers: {
      Origin: ctx.origin,
      'X-CSRF-Token': ctx.csrf,
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  const data = await result.json();
  if (!result.ok) throw new Error(`${result.status} ${data.code}`);
  return data;
}
const login = await call(0, '/auth/login', { login: 'organizer', password: 'demo12345', deviceLabel: 'Load check' });
const token = login.accessToken;
const ids = [];
for (let i = 0; i < count; i++)
  ids.push(
    (
      await call(
        i,
        '/tournaments/demo/teams',
        { name: `Load ${randomUUID()}`, organization: 'Load check', leaderName: 'Local check' },
        token,
      )
    ).id,
  );
const latencies = [];
let cursor = 0,
  failures = 0;
const monitor = new pg.Client({ connectionString: 'postgres://postgres:postgres@127.0.0.1:55434/sapientum_identity' });
await monitor.connect();
const metrics = async () =>
  process.env.DEMO_SERVICE_KEY
    ? (
        await (
          await fetch('http://127.0.0.1:3001/internal/metrics', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': process.env.DEMO_SERVICE_KEY },
            body: '{}',
          })
        ).json()
      ).sessionRowUpdates
    : null;
const writesBefore = await metrics();
let finished = false,
  lockSamples = 0,
  blockedSamples = 0,
  maxSessionWaiters = 0;
const sampler = (async () => {
  while (!finished) {
    const { rows } = await monitor.query(
      "SELECT count(*) AS waiting FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%auth_sessions%'",
    );
    const waiting = Number(rows[0].waiting);
    lockSamples++;
    if (waiting) blockedSamples++;
    maxSessionWaiters = Math.max(maxSessionWaiters, waiting);
    await delay(10);
  }
})();
const started = performance.now();
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    while (cursor < ids.length) {
      const i = cursor++,
        began = performance.now();
      try {
        await call(i, `/tournaments/demo/teams/${ids[i]}/confirm`, {}, token);
      } catch (error) {
        failures++;
        console.error(error.message);
      }
      latencies.push(performance.now() - began);
    }
  }),
);
const duration = performance.now() - started;
finished = true;
await sampler;
await monitor.end();
const writesAfter = await metrics();
latencies.sort((a, b) => a - b);
console.log(
  JSON.stringify(
    {
      requests: count,
      concurrency,
      replicas: origins.length,
      failures,
      durationMs: Math.round(duration),
      requestsPerSecond: +((count * 1000) / duration).toFixed(2),
      p50Ms: +latencies[Math.floor((count - 1) * 0.5)].toFixed(2),
      p95Ms: +latencies[Math.floor((count - 1) * 0.95)].toFixed(2),
      lockSamples,
      blockedSamples,
      maxSessionWaiters,
      sessionRowUpdates: writesBefore === null ? null : writesAfter - writesBefore,
    },
    null,
    2,
  ),
);
if (failures) process.exitCode = 1;
const ctx = contexts[0];
const logout = await fetch(ctx.origin + '/auth/sessions/' + login.sessionId, {
  method: 'DELETE',
  headers: { Origin: ctx.origin, 'X-CSRF-Token': ctx.csrf, Authorization: 'Bearer ' + token },
  signal: AbortSignal.timeout(5000),
});
if (logout.status !== 204) throw new Error('Could not close load-check session');
