import { mkdir, chmod, readFile, writeFile, rename, unlink, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes, scrypt } from 'node:crypto';

export const defaultDataDir = join(homedir(), '.ompw');
export interface Credentials { version: 1; salt: string; hash: string; secret: string; lastCounter: number }
const run = promisify(execFile);
export async function privateDirectory(path: string): Promise<string> {
  path = resolve(path);
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') {
    const { stdout } = await run('whoami.exe', ['/user', '/fo', 'csv', '/nh']);
    const sid = stdout.match(/S-1-\d+(?:-\d+)+/)?.[0];
    if (!sid) throw new Error('Cannot determine Windows account SID.');
    await run('icacls.exe', [path, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F']);
    await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', [
      '$ErrorActionPreference = "Stop"',
      '$acl = [System.IO.Directory]::GetAccessControl($env:OMPW_PERMISSION_PATH)',
      '$allowed = @($env:OMPW_PERMISSION_SID, "S-1-5-18", "S-1-5-32-544")',
      'foreach ($rule in $acl.Access) { if ($rule.AccessControlType -eq "Allow" -and $allowed -notcontains $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value) { throw "Private directory has explicit permissions for another account. Remove shared access before starting ompw." } }',
      'foreach ($name in @("auth.json", "daemon.json")) { $file = [System.IO.Path]::Combine($env:OMPW_PERMISSION_PATH, $name); if ([System.IO.File]::Exists($file)) { foreach ($rule in [System.IO.File]::GetAccessControl($file).Access) { if ($rule.AccessControlType -eq "Allow" -and $allowed -notcontains $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value) { throw "Credential or daemon file grants access to another account. Remove shared access before starting ompw." } } } }',
    ].join('; ')], { env: { ...process.env, OMPW_PERMISSION_PATH: path, OMPW_PERMISSION_SID: sid } });
  } else await chmod(path, 0o700);
  return path;
}
export async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => {}); }
}
export async function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((accept, reject) => scrypt(password, Buffer.from(salt, 'hex'), 64,
    { N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024 }, (error, key) => error ? reject(error) : accept(key)));
}
export async function loadCredentials(dataDir: string): Promise<Credentials> {
  let value: Credentials;
  try { value = JSON.parse(await readFile(join(dataDir, 'auth.json'), 'utf8')); }
  catch { throw new Error('Authentication is not initialized. Run: ompw setup'); }
  if (value.version !== 1 || !/^[a-f0-9]{32}$/.test(value.salt) || !/^[a-f0-9]{128}$/.test(value.hash)
    || !/^[A-Z2-7]{32}$/.test(value.secret) || !Number.isSafeInteger(value.lastCounter)) throw new Error('Invalid authentication configuration.');
  return value;
}
export async function acquireLock(dataDir: string): Promise<() => Promise<void>> {
  const path = join(dataDir, 'server.lock');
  try {
    const file = await open(path, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify({ pid: process.pid })); }
    finally { await file.close(); }
    return async () => { await unlink(path); };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    // Never auto-unlink a stale lock: concurrent recovery could delete a new owner's lock.
    throw new Error(`Instance lock exists: ${path}. Stop ompw first. After a crash, verify both ompw and its OMP child have exited before removing this file.`);
  }
}
