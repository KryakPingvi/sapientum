import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readJson, passwordDigest } from './dev-security.mjs';

test('UTF-8 reader preserves every byte boundary and enforces original byte limit', async () => {
  const value = { name: 'Ёжики 🦔', leaderName: 'Иван Иванов', organization: 'Школа №1' };
  const bytes = Buffer.from(JSON.stringify(value));
  for (let boundary = 1; boundary < bytes.length; boundary++)
    assert.deepEqual(await readJson(Readable.from([bytes.subarray(0, boundary), bytes.subarray(boundary)])), value);
  assert.deepEqual(await readJson(Readable.from([...bytes].map((byte) => Buffer.from([byte])))), value);
  assert.equal(await readJson(Readable.from([])), undefined);
  await assert.rejects(readJson(Readable.from([Buffer.alloc(16385, 32)])), { code: 'BODY_TOO_LARGE' });
  await assert.rejects(readJson(Readable.from([Buffer.from([0xff])])), { code: 'INVALID_JSON' });
  await assert.rejects(readJson(Readable.from([Buffer.from('{')])), { code: 'INVALID_JSON' });
});

test('async password hashing preserves whitespace, salt and event loop responsiveness', async () => {
  let turn = false;
  setImmediate(() => {
    turn = true;
  });
  const first = await passwordDigest(' secret ', 'salt');
  assert.equal(turn, true);
  assert.notDeepEqual(first, await passwordDigest('secret', 'salt'));
  assert.notDeepEqual(first, await passwordDigest(' secret ', 'different'));
  assert.deepEqual(first, await passwordDigest(' secret ', 'salt'));
});
