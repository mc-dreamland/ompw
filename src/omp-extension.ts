import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export interface SavedSession {
  sessionFile: string | null;
  sessionId: string | null;
  cwd: string;
}

export interface RuntimeMetadata extends SavedSession {
  runId: string;
  pid: number;
  phase: 'ready' | 'shutdown';
  error?: string;
}

export interface NativeOwner {
  id: string;
  runId: string;
  hostDir: string;
  managerPid: number;
}

export function canonicalPath(path: string): string {
  const absolute = resolve(path);
  let canonical: string;
  try { canonical = realpathSync.native(absolute); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = dirname(absolute);
    if (parent === absolute) throw error;
    canonical = join(canonicalPath(parent), basename(absolute));
  }
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

export function nativeKeys(path: string): string[] {
  const keys = [`path:${canonicalPath(path)}`];
  try {
    const stat = statSync(path, { bigint: true });
    if (!stat.isFile()) throw new Error(`Native session is not a file: ${path}`);
    if (stat.ino !== 0n) keys.push(`inode:${stat.dev}:${stat.ino}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return keys;
}

export function processAlive(pid: unknown): boolean {
  if (!Number.isSafeInteger(pid) || (pid as number) <= 0) throw new Error('Cannot establish the previous OMP process identity. Inspect its private host-process.json before recovery.');
  try { process.kill(pid as number, 0); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw new Error('Cannot establish whether the previous OMP process exited. Check local process permissions.');
  }
}

export function readMetadata(path: string): unknown {
  if (statSync(path).size > 32 * 1024) throw new Error(`Private metadata exceeds its size limit: ${path}`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function assertHostExited(hostDir: string): void {
  for (const name of ['host-process.json', 'runtime.json']) {
    let value: unknown;
    try { value = readMetadata(join(hostDir, name)); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (processAlive((value as { pid?: unknown } | null)?.pid)) throw new Error(`The previous OMP process is still alive (${hostDir}). Stop it gracefully before resuming its native session.`);
  }
}

function sameOwner(left: NativeOwner, right: NativeOwner): boolean {
  return !!left && left.id === right.id && left.runId === right.runId && left.hostDir === right.hostDir;
}

export function reserveNative(lockDir: string, owner: NativeOwner, path: string): void {
  mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  const created: string[] = [];
  try {
    for (const key of nativeKeys(path)) {
      const lock = join(lockDir, `${createHash('sha256').update(key).digest('hex')}.json`);
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          writeFileSync(lock, JSON.stringify({ ...owner, path: resolve(path) }), { flag: 'wx', mode: 0o600 });
          created.push(lock);
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          const previous = readMetadata(lock) as NativeOwner;
          if (sameOwner(previous, owner)) break;
          if (!previous || typeof previous.hostDir !== 'string' || typeof previous.id !== 'string' || typeof previous.runId !== 'string') throw new Error(`Cannot establish native session ownership. Inspect ${lock}.`);
          // Only the manager may reclaim an abandoned run after PTY and replacement death.
          if (process.pid !== owner.managerPid || processAlive(previous.managerPid)) throw new Error(`Native session is already reserved by hosted session ${previous.id}. Stop that host before resuming ${path}.`);
          assertHostExited(previous.hostDir);
          if (attempt !== 0) throw new Error(`Native ownership changed while reserving ${path}. Retry the operation.`);
          unlinkSync(lock);
        }
      }
    }
  } catch (error) {
    // No native write has begun; unwind only this incomplete reservation.
    for (const lock of created) {
      try { unlinkSync(lock); } catch {}
    }
    throw error;
  }
}

export function releaseNative(lockDir: string, owner: NativeOwner): void {
  let files: string[];
  try { files = readdirSync(lockDir); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const path = join(lockDir, file);
    const existing = readMetadata(path) as NativeOwner;
    if (sameOwner(existing, owner)) unlinkSync(path);
  }
}

interface ExtensionContext {
  hasUI: boolean;
  cwd: string;
  sessionManager: { getSessionFile(): string | undefined; getSessionId(): string };
  ui: { notify(message: string, type: 'error'): void };
  isIdle(): boolean;
  abort(): Promise<void>;
  setInterval(callback: () => void | Promise<void>, milliseconds: number): unknown;
  clearTimer(timer: unknown): void;
}

interface ExtensionAPI {
  pi: { FileSessionStorage: { prototype: Record<string, unknown> } };
  on(event: string, callback: (event: { reason?: string; targetSessionFile?: string }, context: ExtensionContext) => unknown): void;
}

function atomicWrite(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export default function bridge(pi: ExtensionAPI): void {
  const runtimeFile = process.env.OMPW_RUNTIME_FILE;
  const lastFile = process.env.OMPW_LAST_SESSION_FILE;
  const stopFile = process.env.OMPW_STOP_FILE;
  const runId = process.env.OMPW_RUN_ID;
  if (!runtimeFile || !lastFile || !stopFile || !runId) return;
  const lockDir = process.env.OMPW_NATIVE_LOCK_DIR;
  const ownerText = process.env.OMPW_NATIVE_OWNER;
  const owner = ownerText ? JSON.parse(ownerText) as NativeOwner : undefined;
  const reserve = (path: string | undefined) => {
    if (path && lockDir && owner) reserveNative(lockDir, owner, path);
  };

  // Hooks expose no /new or /fork destination. Guard native storage before its first write,
  // including synchronous /branch, and keep the reservation through process replacement.
  if (owner && lockDir) {
    const prototype = pi.pi?.FileSessionStorage?.prototype;
    if (!prototype) throw new Error('This OMP runtime cannot enforce native session ownership. Upgrade OMP before hosting sessions.');
    const methods = ['writeTextSync', 'writeText', 'writeTextAtomic', 'openWriter', 'updateSessionTitle', 'rename', 'renameSync', 'unlink', 'deleteSessionWithArtifacts'];
    for (const name of methods) {
      if (typeof prototype[name] !== 'function') throw new Error(`OMP native storage lacks ${name}; hosting is disabled to protect session ownership.`);
    }
    if (prototype.__ompwOwnershipRunId !== runId) for (const name of methods) {
      const original = prototype[name];
      if (typeof original !== 'function') throw new Error(`OMP native storage lacks ${name}; hosting is disabled to protect session ownership.`);
      prototype[name] = function(this: unknown, ...args: unknown[]) {
        for (const index of name === 'rename' || name === 'renameSync' ? [0, 1] : [0]) {
          const path = args[index];
          if (typeof path === 'string' && path.toLowerCase().endsWith('.jsonl')) reserve(path);
        }
        return Reflect.apply(original, this, args);
      };
    }
    prototype.__ompwOwnershipRunId = runId;
  }

  let current: ExtensionContext | undefined;
  let timer: unknown;
  let stopping = false;
  let lastSaved = '';
  let lastRuntime = '';
  const publish = (ctx: ExtensionContext, phase: RuntimeMetadata['phase'] = 'ready', error?: string) => {
    const saved: SavedSession = {
      sessionFile: ctx.sessionManager.getSessionFile() ?? null,
      sessionId: ctx.sessionManager.getSessionId() || null,
      cwd: ctx.cwd,
    };
    reserve(saved.sessionFile ?? undefined);
    const savedText = JSON.stringify(saved);
    if (savedText !== lastSaved) { atomicWrite(lastFile, saved); lastSaved = savedText; }
    const runtime: RuntimeMetadata = { ...saved, runId, pid: process.pid, phase };
    if (error) runtime.error = error;
    const runtimeText = JSON.stringify(runtime);
    if (runtimeText !== lastRuntime) { atomicWrite(runtimeFile, runtime); lastRuntime = runtimeText; }
  };
  const poll = async () => {
    const ctx = current;
    if (!ctx || stopping) return;
    publish(ctx);
    let request: { runId?: unknown };
    try {
      if (statSync(stopFile).size > 1024) return;
      request = JSON.parse(readFileSync(stopFile, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (request?.runId !== runId) return;
    unlinkSync(stopFile);
    stopping = true;
    try {
      if (!ctx.isIdle()) await ctx.abort();
      publish(current ?? ctx);
      // ctx.shutdown only sets a flag while the idle input loop sleeps.
      if (!process.emit('SIGTERM')) throw new Error('OMP has no graceful signal handler.');
    } catch {
      stopping = false;
      publish(current ?? ctx, 'ready', 'OMP could not abort or shut down. Retry stopping after the current operation settles.');
    }
  };
  pi.on('session_before_switch', (event, ctx) => {
    if (!ctx.hasUI || event.reason !== 'resume') return;
    try {
      if (!event.targetSessionFile) throw new Error('OMP did not provide a native resume destination.');
      reserve(event.targetSessionFile);
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : 'Cannot reserve the native session.', 'error');
      return { cancel: true };
    }
  });
  const activate = (_event: unknown, ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    current = ctx;
    publish(ctx);
    if (timer === undefined) timer = ctx.setInterval(poll, 250);
  };
  pi.on('session_start', activate);
  pi.on('session_switch', activate);
  pi.on('session_branch', activate);
  pi.on('session_shutdown', (_event, ctx) => {
    if (!ctx.hasUI) return;
    if (timer !== undefined) ctx.clearTimer(timer);
    timer = undefined;
    current = undefined;
    publish(ctx, 'shutdown');
  });
}
