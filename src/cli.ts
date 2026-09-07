#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { isAbsolute, join, resolve } from 'node:path';
import { readFile, access, realpath, mkdir, rename, open } from 'node:fs/promises';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { password as passwordPrompt, input, confirm } from '@inquirer/prompts';
import { Secret, TOTP } from 'otpauth';
import { acquireLock, atomicJson, defaultDataDir, derive, loadCredentials, privateDirectory } from './config.ts';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { daemonAddress, control } from './control.ts';
import { runDaemon, type DaemonOptions } from './daemon.ts';
import { normalizeOtp } from './otp.ts';

const help = `ompw - authenticated native OMP terminal
Copyright 2026 Mc-andan and contributors. GPL-3.0-only. No warranty.
License and corresponding source: https://github.com/Mc-andan/ompw

  ompw                         Host OMP in the current project (default)
  ompw setup                   Set or replace login credentials
  ompw auth-check              Diagnose password and authenticator locally (read-only)
  ompw --new                   Create another OMP in this project
  ompw stop                    Stop the daemon and all hosted OMP processes
  ompw --resume ID_OR_PATH      Host an existing native OMP session
  ompw status                  List all managed sessions
  ompw install                 Install the packaged Windows command for this user

Options:
  --host ADDRESS     Listener (default 127.0.0.1)
  --port NUMBER      Listener port (default 4310)
  --origin URL       Exact browser origin; required outside default loopback
  --cert PATH        PEM TLS certificate
  --key PATH         PEM TLS private key
  --omp PATH         OMP executable (default omp.exe on Windows, omp elsewhere)
  --data-dir PATH    Private state directory (default ~/.ompw)

setup prompts locally for a password and authenticator enrollment.
setup replaces credentials only after confirmation; stop the server first.
HTTP is loopback-only. HTTPS requires --cert and --key for non-loopback binds.
Browser disconnect/logout never ends OMP. Release it in the UI before using
omp --resume with the displayed native session path. Stop standalone OMP
before starting hosting again. Credentials confer this OS user's privileges.
`;
async function migrateLegacySession(dataDir: string): Promise<void> {
  let saved: { cwd?: unknown };
  try { saved = JSON.parse(await readFile(join(dataDir, 'last-session.json'), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  if (typeof saved.cwd !== 'string' || !isAbsolute(saved.cwd)) throw new Error('Invalid legacy session directory; inspect last-session.json before continuing.');
  const cwd = await realpath(saved.cwd);
  const key = createHash('sha256').update(process.platform === 'win32' ? cwd.toLowerCase() : cwd).digest('hex');
  const target = join(dataDir, 'workspaces', key);
  await mkdir(target, { recursive: true, mode: 0o700 });
  // Move the primary record last so interrupted migrations can resume without losing ownership markers.
  for (const name of ['runtime.json', 'host-process.json', 'stop-request.json', 'fresh-session.yml', 'last-session.json']) {
    try { await access(join(dataDir, name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    let exists = false;
    try { await access(join(target, name)); exists = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (exists) throw new Error(`Session migration conflict: ${join(target, name)}. Existing records were not overwritten.`);
    await rename(join(dataDir, name), join(target, name));
  }
}

async function checkAuthentication(dataDir: string): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('auth-check requires an interactive local terminal.');
  const credentials = await loadCredentials(dataDir);
  const password = await passwordPrompt({ message: 'Administrator password (hidden):', mask: '*' });
  const code = await passwordPrompt({ message: 'Current ompw authenticator code (hidden):', mask: '*', validate: value => normalizeOtp(value) !== undefined || 'Enter six digits.' });
  const matches = timingSafeEqual(await derive(password, credentials.salt), Buffer.from(credentials.hash, 'hex'));
  const now = Date.now();
  const totp = new TOTP({ secret: credentials.secret, digits: 6, period: 30 });
  const normalized = normalizeOtp(code)!;
  const delta = totp.validate({ token: normalized, timestamp: now, window: 1 });
  console.log(`PASSWORD: ${matches ? 'MATCH' : 'MISMATCH'}`);
  if (delta !== null) {
    const consumed = Math.floor(now / 30000) + delta <= credentials.lastCounter;
    console.log(`OTP: ${consumed ? 'ALREADY_USED' : 'MATCH'}`);
  } else {
    // A broader search diagnoses possible clock drift only; it never authorizes a login.
    const offset = totp.validate({ token: normalized, timestamp: now, window: 20 });
    console.log(offset === null ? 'OTP: MISMATCH' : `OTP: POSSIBLE_CLOCK_OFFSET (${offset * 30} seconds)`);
  }
  console.log(`SERVER_TIME: ${new Date(now).toISOString()}`);
  console.log(`CREDENTIAL_FILE: ${join(dataDir, 'auth.json')}`);
  console.log('Read-only check. No login created, no code consumed, no credentials changed.');
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, strict: true, options: {
    help: { type: 'boolean', short: 'h' }, 'data-dir': { type: 'string' }, cwd: { type: 'string' }, resume: { type: 'string' },
    host: { type: 'string' }, port: { type: 'string' }, origin: { type: 'string' }, cert: { type: 'string' }, key: { type: 'string' }, omp: { type: 'string' }, new: { type: 'boolean' }
  } });
  const command = positionals[0] ?? 'serve';
  if (values.help) { console.log(help); return; }
  if (positionals.length > 1 || !['setup', 'serve', 'status', 'stop', 'daemon', 'auth-check'].includes(command)) throw new Error('Unknown command. Use --help.');
  const dataDir = resolve(values['data-dir'] ?? defaultDataDir);
  if (command === 'auth-check') { await checkAuthentication(dataDir); return; }
  if (command === 'daemon') { await runDaemon(dataDir); return; }
  const cwd = await realpath(resolve(values.cwd ?? process.cwd()));
  if (values.new && values.resume) throw new Error('--new and --resume cannot be combined.');
  let address = await daemonAddress(dataDir);
  if (command === 'status' || command === 'stop') {
    if (!address) { console.log('ompw daemon is not running.'); return; }
    console.log(JSON.stringify(await control(address,{type:command==='stop'?'shutdown':'status'}),null,2));
    return;
  }
  if (address && command === 'setup') throw new Error('Run ompw stop before replacing login credentials.');
  let exists = false;
  try { await access(join(dataDir, 'auth.json')); exists = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (command === 'setup' || !exists) {
    await privateDirectory(dataDir);
    const unlock = await acquireLock(dataDir);
    try {
      if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Authentication is not initialized. Run ompw setup in an interactive terminal.');
      if (exists && !await confirm({ message: 'Replace authentication credentials and authenticator?', default: false })) return;
      const password = await passwordPrompt({ message: 'Administrator password (16+ characters):', mask: '*', validate: value => value.length >= 16 && Buffer.byteLength(value) <= 1024 || 'Use 16+ characters, at most 1024 UTF-8 bytes.' });
      const repeated = await passwordPrompt({ message: 'Repeat password:', mask: '*' });
      const left = Buffer.from(password); const right = Buffer.from(repeated);
      if (left.length !== right.length || !timingSafeEqual(left, right)) throw new Error('Passwords do not match.');
      const secret = new Secret({ size: 20 });
      const totp = new TOTP({ issuer: 'ompw', label: 'administrator', secret, digits: 6, period: 30 });
      console.log(`Authenticator enrollment (keep private):\n${totp.toString()}\nManual key: ${secret.base32}`);
      const code = await input({ message: 'Current authenticator code:', validate: value => normalizeOtp(value) !== undefined || 'Enter six digits.' });
      const now = Date.now();
      const delta = totp.validate({ token: normalizeOtp(code)!, timestamp: now, window: 1 });
      if (delta === null) throw new Error('Authenticator verification failed. Nothing changed.');
      const salt = randomBytes(16).toString('hex');
      const hash = (await derive(password, salt)).toString('hex');
      await atomicJson(join(dataDir, 'auth.json'), { version: 1, salt, hash, secret: secret.base32, lastCounter: Math.floor(now / 30000) + delta });
      console.log('Authentication initialized. Wait for a new authenticator code before logging in.');
    } finally { await unlock(); }
    if (command === 'setup') return;
  }
  if (!address) {
    await privateDirectory(dataDir);
    const launcherDir = await privateDirectory(join(dataDir,'launcher'));
    let launchLock: (() => Promise<void>) | undefined;
    const launchDeadline = Date.now()+25000;
    while (!launchLock) {
      try { launchLock=await acquireLock(launcherDir); }
      catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith('Instance lock exists') || Date.now()>=launchDeadline) throw error;
        await delay(100);
      }
    }
    try {
      address = await daemonAddress(dataDir);
      if (!address) {
        // Respect the old single-host lock; never migrate while that process can still write.
        const unlock = await acquireLock(dataDir);
        try { await migrateLegacySession(dataDir); } finally { await unlock(); }
        let saved: Partial<DaemonOptions> = {};
        try { saved = JSON.parse(await readFile(join(dataDir,'service.json'),'utf8')); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        const host = values.host ?? saved.host ?? '127.0.0.1';
        const port = Number(values.port ?? saved.port ?? 4310);
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid --port.');
        const cert = values.cert ? resolve(values.cert) : saved.cert;
        const key = values.key ? resolve(values.key) : saved.key;
        const origin = values.origin ?? saved.origin ?? `${cert?'https':'http'}://${host.includes(':')?`[${host}]`:host}:${port}`;
        await atomicJson(join(dataDir,'service.json'),{host,port,origin,cert,key,ompPath:values.omp ?? saved.ompPath ?? (process.platform==='win32'?'omp.exe':'omp')});
        const log = await open(join(dataDir,'daemon.log'),'a',0o600);
        try {
          const child = spawn(process.execPath,[fileURLToPath(import.meta.url),'daemon','--data-dir',dataDir],{cwd,detached:true,stdio:['ignore',log.fd,log.fd],windowsHide:true});
          const spawned=Promise.withResolvers<void>();
          child.once('spawn',spawned.resolve);child.once('error',spawned.reject);
          await spawned.promise;
          child.unref();
        } finally { await log.close(); }
        const deadline=Date.now()+20000;
        while(!address && Date.now()<deadline) { await delay(100); address=await daemonAddress(dataDir); }
        if(!address) throw new Error(`Daemon did not become ready. Inspect ${join(dataDir,'daemon.log')}.`);
      }
    } finally { await launchLock(); }
  } else if (values.host || values.port || values.origin || values.cert || values.key || values.omp) {
    throw new Error('Service options cannot be changed while the daemon is running. Run ompw stop first.');
  }
  const result = await control(address!,{type:'register',cwd,newSession:values.new,resume:values.resume});
  console.log(`OMP: ${result.session.name} (${result.session.state})`);
  console.log(`${result.origin}/?session=${result.session.id}`);
  console.log('OMP continues in the background. Use ompw stop to shut down the service.');
}
main().catch(error => { console.error((error as Error).message); process.exitCode = 1; });
