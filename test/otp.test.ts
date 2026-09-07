import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Secret, TOTP } from 'otpauth';
import { Authentication, AuthError } from '../src/auth.ts';
import { derive } from '../src/config.ts';

test('formatted authenticator codes authenticate without changing the six-digit value', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ompw-otp-format-'));
  try {
    const password = randomBytes(24).toString('hex'); const salt = randomBytes(16).toString('hex'); const secret = new Secret();
    const auth = new Authentication({ version: 1, salt, hash: (await derive(password, salt)).toString('hex'), secret: secret.base32, lastCounter: -1 }, directory);
    const code = new TOTP({ secret }).generate();
    const formatted = code.replace(/[0-9]/g, digit => String.fromCharCode(0xff10 + Number(digit))).slice(0, 3) + '\u202f' + code.slice(3);
    const result = await auth.login(password, formatted, 'local');
    assert.ok(auth.authenticate(result.token));
    await assert.rejects(auth.login(password, code, 'local'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a consumed enrollment code gives retry guidance but cannot authenticate again', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ompw-otp-replay-'));
  try {
    t.mock.timers.enable({ apis: ['Date'], now: 1800000010000 });
    const password = randomBytes(24).toString('hex'); const salt = randomBytes(16).toString('hex'); const secret = new Secret();
    const auth = new Authentication({ version: 1, salt, hash: (await derive(password, salt)).toString('hex'), secret: secret.base32, lastCounter: Math.floor(Date.now() / 30000) }, directory);
    const code = new TOTP({ secret }).generate();
    await assert.rejects(auth.login('incorrect password', code, 'local'), (error: unknown) => error instanceof AuthError && error.status === 401);
    await assert.rejects(auth.login(password, code, 'local'), (error: unknown) => {
      const failure = error as AuthError & { code?: string; retryAfter?: number };
      assert.equal(failure.code, 'OTP_REUSED');
      assert.equal(failure.retryAfter, 20);
      return true;
    });
    t.mock.timers.tick(20000);
    const result = await auth.login(password, new TOTP({ secret }).generate(), 'local');
    assert.ok(auth.authenticate(result.token));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
