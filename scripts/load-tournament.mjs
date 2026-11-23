import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
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
    },
    null,
    2,
  ),
);
if (failures) process.exitCode = 1;
