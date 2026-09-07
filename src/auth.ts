import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { TOTP } from 'otpauth';
import { atomicJson, derive, type Credentials } from './config.ts';
import { normalizeOtp } from './otp.ts';

const IDLE_MS = 30 * 60_000;
const ABSOLUTE_MS = 12 * 60 * 60_000;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');
export interface LoginSession { id: string; csrf: string; issued: number; seen: number }
export class AuthError extends Error {
  status: number;
  code: 'INVALID_CREDENTIALS' | 'RATE_LIMITED' | 'OTP_REUSED';
  retryAfter?: number;
  constructor(status: number, code: AuthError['code'] = status === 429 ? 'RATE_LIMITED' : 'INVALID_CREDENTIALS', retryAfter?: number) {
    super(code === 'OTP_REUSED' ? 'Authenticator code already used. Wait for the next code.' : status === 429 ? 'Too many attempts. Try again later.' : 'Invalid credentials.');
    this.status = status; this.code = code; this.retryAfter = retryAfter;
  }
}
export class Authentication {
  #credentials: Credentials;
  #path: string;
  #sessions = new Map<string, LoginSession>();
  #attempts = new Map<string, { count: number; expires: number }>();
  #global = { count: 0, expires: 0 };
  #verifying = false;
  constructor(credentials: Credentials, dataDir: string) { this.#credentials = credentials; this.#path = join(dataDir, 'auth.json'); }
  #admit(address: string, now: number) {
    for (const [key, value] of this.#attempts) if (value.expires <= now) this.#attempts.delete(key);
    if (this.#global.expires <= now) this.#global = { count: 0, expires: now + 300_000 };
    const attempts = this.#attempts.get(address) ?? { count: 0, expires: now + 300_000 };
    if (this.#verifying) throw new AuthError(429, 'RATE_LIMITED', 1);
    if (attempts.count >= 5 || this.#global.count >= 20 || this.#attempts.size >= 1024) {
      const retryAt = Math.max(attempts.count >= 5 ? attempts.expires : now, this.#global.count >= 20 ? this.#global.expires : now);
      throw new AuthError(429, 'RATE_LIMITED', retryAt > now ? Math.ceil((retryAt - now) / 1000) : 300);
    }
    attempts.count++;
    this.#global.count++;
    this.#attempts.set(address, attempts);
  }
  async login(password: unknown, code: unknown, address: string): Promise<{ token: string; session: LoginSession }> {
    const now = Date.now();
    this.#admit(address, now);
    const normalized = normalizeOtp(code);
    if (typeof password !== 'string' || Buffer.byteLength(password) > 1024 || !normalized) throw new AuthError(401);
    this.#verifying = true;
    try {
      const key = await derive(password, this.#credentials.salt);
      const matches = timingSafeEqual(key, Buffer.from(this.#credentials.hash, 'hex'));
      const timestamp = Date.now();
      const delta = new TOTP({ secret: this.#credentials.secret, digits: 6, period: 30 }).validate({ token: normalized, timestamp, window: 1 });
      const counter = Math.floor(timestamp / 30_000) + (delta ?? 0);
      if (!matches || delta === null) throw new AuthError(401);
      if (counter <= this.#credentials.lastCounter) {
        throw new AuthError(401, 'OTP_REUSED', Math.max(1, Math.ceil(((this.#credentials.lastCounter + 1) * 30_000 - timestamp) / 1000)));
      }
      // Persist consumption before issuing a cookie: a restart must not permit OTP replay.
      const updated = { ...this.#credentials, lastCounter: counter };
      await atomicJson(this.#path, updated);
      this.#credentials = updated;
      this.prune();
      if (this.#sessions.size >= 8) this.#sessions.delete(this.#sessions.keys().next().value!);
      const raw = token();
      const session = { id: digest(raw), csrf: token(), issued: timestamp, seen: timestamp };
      this.#sessions.set(session.id, session);
      return { token: raw, session };
    } finally { this.#verifying = false; }
  }
  authenticate(raw: string | undefined, touch = false): LoginSession | undefined {
    if (!raw || !/^[A-Za-z0-9_-]{43}$/.test(raw)) return undefined;
    const session = this.#sessions.get(digest(raw));
    return session && this.validate(session, touch) ? session : undefined;
  }
  validate(session: LoginSession, touch = false): boolean {
    const now = Date.now();
    if (this.#sessions.get(session.id) !== session || now - session.issued >= ABSOLUTE_MS || now - session.seen >= IDLE_MS) {
      this.#sessions.delete(session.id); return false;
    }
    if (touch) session.seen = now;
    return true;
  }
  csrf(session: LoginSession, provided: unknown): boolean {
    return typeof provided === 'string' && /^[A-Za-z0-9_-]{43}$/.test(provided)
      && timingSafeEqual(Buffer.from(provided), Buffer.from(session.csrf));
  }
  revoke(session: LoginSession) { this.#sessions.delete(session.id); }
  prune() { for (const session of this.#sessions.values()) this.validate(session); }
}
