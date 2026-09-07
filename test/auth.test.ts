import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Secret, TOTP } from 'otpauth';
import { Authentication, AuthError } from '../src/auth.ts';
import { atomicJson, derive, acquireLock, type Credentials } from '../src/config.ts';

test('password and OTP are both required; OTP consumption survives restart; logout revokes access', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ompw-auth-'));
  try {
    const password = randomBytes(24).toString('hex');
    const secret = new Secret({ size: 20 });
    const salt = randomBytes(16).toString('hex');
    const config: Credentials = { version: 1, salt, hash: (await derive(password, salt)).toString('hex'), secret: secret.base32, lastCounter: -1 };
    const auth = new Authentication(config, directory);
    const otp = new TOTP({ secret });
    await assert.rejects(auth.login('incorrect password', otp.generate(), 'local'), (e: unknown) => e instanceof AuthError && e.status === 401);
    const result = await auth.login(password, otp.generate(), 'local');
    assert.equal(auth.authenticate(result.token), result.session);
    assert.equal(auth.authenticate(randomBytes(32).toString('base64url')), undefined);
    assert.equal(auth.csrf(result.session, result.session.csrf), true);
    assert.equal(auth.csrf(result.session, '\u00e9'.repeat(43)), false);
    assert.equal(auth.csrf(result.session, randomBytes(32).toString('base64url')), false);
    const persisted = JSON.parse(await readFile(join(directory, 'auth.json'), 'utf8'));
    const restarted = new Authentication(persisted, directory);
    assert.equal(restarted.authenticate(result.token), undefined);
    const usedCode = otp.generate({ timestamp: persisted.lastCounter * 30_000 });
    await assert.rejects(restarted.login(password, usedCode, 'local'), (e: unknown) => e instanceof AuthError && e.status === 401);
    auth.revoke(result.session);
    assert.equal(auth.authenticate(result.token), undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('idle sessions expire and active sessions cannot exceed the absolute lifetime', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ompw-expiry-'));
  try {
    const password = randomBytes(24).toString('hex'); const salt = randomBytes(16).toString('hex'); const secret = new Secret();
    const auth = new Authentication({ version: 1, salt, hash: (await derive(password, salt)).toString('hex'), secret: secret.base32, lastCounter: -1 }, directory);
    const result = await auth.login(password, new TOTP({ secret }).generate(), 'local');
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    t.mock.timers.tick(31 * 60_000);
    assert.equal(auth.authenticate(result.token), undefined);
    const active = await auth.login(password, new TOTP({ secret }).generate(), 'local');
    for (let n = 0; n < 24; n++) {
      t.mock.timers.tick(29 * 60_000);
      assert.ok(auth.authenticate(active.token, true));
    }
    t.mock.timers.tick(25 * 60_000);
    assert.equal(auth.authenticate(active.token, true), undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('invalid attempts are bounded before expensive password verification', async () => {
  const auth = new Authentication({ version: 1, salt: '0'.repeat(32), hash: '0'.repeat(128), secret: 'A'.repeat(32), lastCounter: -1 }, tmpdir());
  for (let n = 0; n < 5; n++) await assert.rejects(auth.login(null, null, 'same'), (e: unknown) => e instanceof AuthError && e.status === 401);
  await assert.rejects(auth.login(null, null, 'same'), (e: unknown) => e instanceof AuthError && e.status === 429);
  for (let n = 0; n < 15; n++) await assert.rejects(auth.login(null, null, `peer-${n}`), (e: unknown) => e instanceof AuthError && e.status === 401);
  await assert.rejects(auth.login(null, null, 'new-peer'), (e: unknown) => e instanceof AuthError && e.status === 429);
});

test('existing lock is never stolen, including stale or malformed locks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ompw-lock-'));
  try {
    const unlock = await acquireLock(directory);
    await assert.rejects(acquireLock(directory), /Instance lock exists/);
    await unlock();
    await atomicJson(join(directory, 'server.lock'), { pid: 2147483647 });
    await assert.rejects(acquireLock(directory), /Instance lock exists/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
