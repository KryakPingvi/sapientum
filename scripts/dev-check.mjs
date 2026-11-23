import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
const origin = 'http://127.0.0.1:3000';
const context = await (await fetch(origin + '/dev/context')).json();
async function call(path, method = 'GET', body, token = '', cookie = '') {
  const response = await fetch(origin + path, {
    method,
    headers: {
      Origin: origin,
      'X-CSRF-Token': context.csrf,
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return {
    status: response.status,
    body: response.status === 204 ? null : await response.json(),
    cookie: response.headers.get('set-cookie')?.split(';')[0],
  };
}
async function login(user) {
  const result = await call('/auth/login', 'POST', { login: user, password: 'demo12345', deviceLabel: 'HTTP smoke' });
  assert.equal(result.status, 200);
  return result;
}
assert.equal((await call('/tournaments/demo/teams')).status, 200);
const leader = await login('leader'),
  organizer = await login('organizer');
const access = organizer.body.accessToken;
assert.equal((await call('/dev/registration', 'POST', { open: true }, access)).status, 200);
const name = `HTTP ${randomUUID()}`;
const team = await call(
  '/tournaments/demo/teams',
  'POST',
  { name, organization: 'Demo school', leaderName: 'Manual tester' },
  leader.body.accessToken,
);
assert.equal(team.status, 201);
const confirm = `/tournaments/demo/teams/${team.body.id}/confirm`;
assert.equal((await call(confirm, 'POST', {}, leader.body.accessToken)).status, 403);
assert.equal((await call(confirm, 'POST', {}, access)).status, 200);
assert.equal((await call(confirm, 'POST', {}, access)).status, 409);
const second = await login('leader');
assert.equal(
  (await call(`/auth/sessions/${leader.body.sessionId}`, 'DELETE', null, second.body.accessToken)).status,
  204,
);
assert.equal((await call('/auth/sessions', 'GET', null, leader.body.accessToken)).status, 401);
assert.equal((await call('/auth/refresh', 'POST', {}, '', leader.cookie)).status, 401);
assert.equal((await call('/auth/sessions', 'GET', null, second.body.accessToken)).status, 200);
assert.equal(
  (await call(`/auth/sessions/${second.body.sessionId}`, 'DELETE', null, second.body.accessToken)).status,
  204,
);
assert.equal((await call(`/auth/sessions/${organizer.body.sessionId}`, 'DELETE', null, access)).status, 204);
console.log('HTTP check passed: login, public list, application, permissions, confirmation, session revocation.');
