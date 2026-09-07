import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pty from 'node-pty';
import headless from '@xterm/headless';
import serialization from '@xterm/addon-serialize';
import { releaseNative, reserveNative, type NativeOwner, type RuntimeMetadata, type SavedSession } from './omp-extension.ts';

const SCROLLBACK = 3000;
const PAUSE_BYTES = 256 * 1024;
const RESUME_BYTES = 64 * 1024;
const MAX_QUEUE_BYTES = 4 * 1024 * 1024;
const LIFECYCLE_TIMEOUT = 30_000;

export interface SessionStatus extends SavedSession {
  state: 'starting' | 'running' | 'stopping' | 'stopped' | 'error';
  cols: number;
  rows: number;
  error?: string;
}

interface SessionOptions {
  cwd: string;
  dataDir: string;
  ompPath: string;
  resume?: string;
  saved?: SavedSession;
  managed?: { id: string; lockDir: string };
}

function readObject(path: string): unknown {
  if (statSync(path).size > 32 * 1024) throw new Error('Metadata file exceeds its size limit.');
  return JSON.parse(readFileSync(path, 'utf8'));
}

function isSavedSession(value: unknown): value is SavedSession {
  if (!value || typeof value !== 'object') return false;
  const session = value as SavedSession;
  return typeof session.cwd === 'string' && isAbsolute(session.cwd)
    && (session.sessionFile === null || (typeof session.sessionFile === 'string' && isAbsolute(session.sessionFile)))
    && (session.sessionId === null || typeof session.sessionId === 'string');
}

function processIsAlive(pid: unknown): boolean {
  if (!Number.isSafeInteger(pid) || (pid as number) <= 0) throw new Error('Cannot establish whether the previous OMP process exited. Inspect host-process.json and the local processes before recovering this data directory.');
  try { process.kill(pid as number, 0); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw new Error('Cannot establish whether the previous OMP process exited. Check local process permissions before recovering this data directory.');
  }
}

function assertPreviousProcessExited(path: string): void {
  let value: unknown;
  try { value = readObject(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new Error('Cannot establish whether the previous OMP process exited. Repair the private process metadata before starting.');
  }
  if (processIsAlive((value as { pid?: unknown } | null)?.pid)) {
    throw new Error('The previous OMP process is still alive. Stop that process gracefully before starting another writer for this data directory.');
  }
}

function removeIfPresent(path: string): void {
  try { unlinkSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function atomicWrite(path: string, content: string): void {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, content, { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    removeIfPresent(temporary);
  }
}

function childEnvironment(runId: string, runtimeFile: string, stopFile: string, lastFile: string): Record<string, string> {
  const result: Record<string, string> = {};
  const inheritedIdentity = /^(?:OMPW(?:_|$)|OMPCODE$|CLAUDECODE$|TMUX(?:_|$)|STY$|WINDOWID$|CMUX_|KITTY_|TERM_SESSION_ID$|WT_|VSCODE_|ITERM_|TERM_PROGRAM(?:_|$)|TERMINAL_EMULATOR$|(?:PI|OMP)_(?:SESSION|PARENT_SESSION|TASK|AGENT_ID|LOCAL_PROTOCOL|SUBAGENT)(?:_|$))/i;
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !inheritedIdentity.test(key)) result[key] = value;
  }
  result.TERM = 'xterm-256color';
  result.COLORTERM = 'truecolor';
  result.TERM_PROGRAM = 'ompw';
  result.TERM_SESSION_ID = `ompw-${runId}`;
  result.PI_FORCE_IMAGE_PROTOCOL = 'none';
  result.PI_NO_DECCARA = '1';
  result.OMPW_RUN_ID = runId;
  result.OMPW_RUNTIME_FILE = runtimeFile;
  result.OMPW_STOP_FILE = stopFile;
  result.OMPW_LAST_SESSION_FILE = lastFile;
  return result;
}

export class HostedSession extends EventEmitter {
  private readonly options: SessionOptions;
  private readonly runtimeFile: string;
  private readonly stopFile: string;
  private readonly lastFile: string;
  private readonly processFile: string;
  private terminal: InstanceType<typeof headless.Terminal>;
  private serializer: InstanceType<typeof serialization.SerializeAddon>;
  private child: pty.IPty | undefined;
  private runId = '';
  private metadataTimer: ReturnType<typeof setInterval> | undefined;
  private state: SessionStatus['state'] = 'stopped';
  private cwd: string;
  private sessionFile: string | null = null;
  private sessionId: string | null = null;
  private cols = 100;
  private rows = 30;
  private error: string | undefined;
  private queuedBytes = 0;
  private outputQueue: string[] = [];
  private writing = false;
  private paused = false;
  private overflow = false;
  private exitCode: number | undefined;
  private stopOperation: Promise<void> | undefined;
  private explicitResume: string | undefined;
  private runtimePid: number | undefined;
  private runtimeShutdown = false;
  private requestedStop = false;
  private snapshotWaiters: Array<(snapshot: string) => void> = [];
  private nativeOwner: NativeOwner | undefined;

  constructor(options: SessionOptions) {
    super();
    this.options = { ...options, cwd: resolve(options.cwd), dataDir: resolve(options.dataDir) };
    this.cwd = this.options.cwd;
    this.explicitResume = options.resume;
    this.runtimeFile = join(this.options.dataDir, 'runtime.json');
    this.stopFile = join(this.options.dataDir, 'stop-request.json');
    this.lastFile = join(this.options.dataDir, 'last-session.json');
    this.processFile = join(this.options.dataDir, 'host-process.json');
    if (options.saved) {
      this.cwd = options.saved.cwd;
      this.sessionFile = options.saved.sessionFile;
      this.sessionId = options.saved.sessionId;
    }
    this.terminal = new headless.Terminal({ cols: this.cols, rows: this.rows, scrollback: SCROLLBACK, allowProposedApi: true });
    this.serializer = new serialization.SerializeAddon();
    this.terminal.loadAddon(this.serializer);
    this.terminal.onData(data => {
      // Device/cursor queries must work even when no browser is connected.
      if (!this.child || this.exitCode !== undefined) return;
      try { this.child.write(data); } catch { this.fail('Cannot answer the OMP terminal. Stop the session and restart it.'); }
    });
  }

  status(): SessionStatus {
    return {
      state: this.state, cwd: this.cwd, sessionFile: this.sessionFile, sessionId: this.sessionId,
      cols: this.cols, rows: this.rows, ...(this.error ? { error: this.error } : {}),
    };
  }

  isActive(): boolean {
    return this.child !== undefined || this.state === 'starting' || this.state === 'stopping';
  }

  async start(fallbackCwd = this.options.cwd): Promise<void> {
    if (this.child || this.state === 'starting' || this.state === 'stopping' || this.stopOperation) {
      throw new Error('OMP is still active. Wait for its actual exit before starting another session.');
    }
    this.state = 'starting';
    this.error = undefined;
    this.emit('status');
    let ownsProcessMarker = false;
    try {
      mkdirSync(this.options.dataDir, { recursive: true, mode: 0o700 });
      assertPreviousProcessExited(this.processFile);
      assertPreviousProcessExited(this.runtimeFile);
      let saved: SavedSession | undefined = this.options.saved;
      try {
        const value = readObject(this.lastFile);
        if (!isSavedSession(value)) throw new Error('Invalid saved session metadata.');
        saved = value;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Cannot read last-session.json. Check the private data directory and restore its metadata before starting.');
      }
      const resume = this.explicitResume ?? saved?.sessionFile ?? this.options.saved?.sessionFile ?? undefined;
      this.cwd = saved?.cwd ?? this.options.cwd;
      this.sessionFile = resume && isAbsolute(resume) ? resume : null;
      this.sessionId = this.explicitResume ? null : saved?.sessionId ?? null;
      this.runId = randomUUID();
      if (this.options.managed) {
        this.nativeOwner = { id: this.options.managed.id, runId: this.runId, hostDir: this.options.dataDir, managerPid: process.pid };
        if (!this.sessionFile) throw new Error('Cannot start a managed host without a reserved native session path.');
        reserveNative(this.options.managed.lockDir, this.nativeOwner, this.sessionFile);
      }
      removeIfPresent(this.runtimeFile);
      removeIfPresent(this.stopFile);
      this.terminal.reset();
      this.emit('data', '\u001bc');
      this.outputQueue = [];
      this.queuedBytes = 0;
      this.writing = false;
      this.paused = false;
      this.overflow = false;
      this.exitCode = undefined;
      this.runtimePid = undefined;
      this.runtimeShutdown = false;
      this.requestedStop = false;
      const args = ['-e', fileURLToPath(new URL('./omp-extension.ts', import.meta.url))];
      if (resume) {
        args.push('--resume', resume);
      } else {
        // Disable only implicit history selection: a first host launch must not take a parent's session.
        const configFile = join(this.options.dataDir, 'fresh-session.yml');
        atomicWrite(configFile, 'autoResume: false\n');
        args.push('--config', configFile);
      }
      atomicWrite(this.processFile, JSON.stringify({ runId: this.runId, pid: null }));
      ownsProcessMarker = true;
      const env = childEnvironment(this.runId, this.runtimeFile, this.stopFile, this.lastFile);
      if (this.nativeOwner && this.options.managed) {
        env.OMPW_NATIVE_OWNER = JSON.stringify(this.nativeOwner);
        env.OMPW_NATIVE_LOCK_DIR = this.options.managed.lockDir;
      }
      let launchCwd = fallbackCwd;
      try { if (statSync(this.cwd).isDirectory()) launchCwd = this.cwd; } catch {}
      const child = pty.spawn(this.options.ompPath, args, {
        name: 'xterm-256color', cols: this.cols, rows: this.rows,
        cwd: launchCwd,
        env,
      });
      this.child = child;
      child.onData(data => this.enqueueOutput(data));
      child.onExit(({ exitCode }) => {
        if (this.child !== child) return;
        this.exitCode = exitCode;
        // On Windows /restart keeps the original process alive until its replacement exits.
        this.readRuntime();
        this.finishExit();
      });
      (child as unknown as EventEmitter).on('error', () => {
        if (this.child === child) this.fail('The OMP PTY reported an error. Check the terminal and request a graceful stop; the process has not been killed.');
      });
      this.metadataTimer = setInterval(() => { this.readRuntime(); this.finishExit(); }, 250);
      this.metadataTimer.unref();
      atomicWrite(this.processFile, JSON.stringify({ runId: this.runId, pid: child.pid }));
    } catch (error) {
      if (!this.child) {
        if (ownsProcessMarker) {
          try { removeIfPresent(this.processFile); } catch {}
        }
        if (this.nativeOwner && this.options.managed) {
          try { releaseNative(this.options.managed.lockDir, this.nativeOwner); } catch {}
        }
      }
      const message = error instanceof Error ? error.message
        : 'Cannot launch OMP. Check the executable, working directory, private data directory permissions, and node-pty installation.';
      this.fail(message);
      throw new Error(message);
    }
    await this.waitFor(() => {
      if (this.state === 'running') return true;
      if (this.state === 'error' || this.state === 'stopped' || this.state === 'stopping') throw new Error(this.error ?? 'OMP exited or began stopping before the extension became ready.');
      return false;
    }, 'OMP did not report ready within 30 seconds. Inspect the terminal for startup dialogs or extension errors; the process remains alive until it actually exits.');
  }

  stop(): Promise<void> {
    if (this.stopOperation) return this.stopOperation;
    if (!this.child) return Promise.resolve();
    const operation = this.requestStop();
    this.stopOperation = operation;
    void operation.finally(() => { this.stopOperation = undefined; }).catch(() => {});
    return operation;
  }

  private async requestStop(): Promise<void> {
    this.state = 'stopping';
    this.requestedStop = true;
    this.error = undefined;
    this.emit('status');
    try {
      atomicWrite(this.stopFile, JSON.stringify({ runId: this.runId }));
    } catch {
      const message = 'Cannot create the graceful-stop request. Check the private data directory permissions; OMP is still active.';
      this.fail(message);
      throw new Error(message);
    }
    await this.waitFor(() => {
      if (this.child) return false;
      if (!this.cleanExit()) throw new Error(this.error ?? 'OMP exited unsuccessfully; graceful handoff could not be confirmed.');
      return true;
    },
      'OMP has not exited after 30 seconds. It is still active and has not been killed. Let its current operation settle and retry Stop; do not resume the transcript elsewhere yet.', true);
  }

  async snapshot(): Promise<string> {
    if (!this.writing) return this.serializer.serialize({ scrollback: SCROLLBACK });
    if (this.snapshotWaiters.length >= 64) throw new Error('Too many terminal snapshots are pending.');
    // The server discards data queued before this barrier: those chunks are in the snapshot.
    const { promise, resolve: resolveSnapshot } = Promise.withResolvers<string>();
    this.snapshotWaiters.push(resolveSnapshot);
    return promise;
  }

  write(data: string): void {
    if (!this.child || this.exitCode !== undefined || this.state === 'stopping') throw new Error('OMP is not accepting input.');
    if (typeof data !== 'string' || Buffer.byteLength(data, 'utf8') > 64 * 1024) throw new Error('Terminal input exceeds 64 KiB.');
    if (!data) return;
    try { this.child.write(data); } catch {
      this.fail('Cannot write to the OMP terminal. Check whether OMP has exited.');
      throw new Error('Cannot write to the OMP terminal.');
    }
  }

  resize(cols: number, rows: number): void {
    if (!Number.isInteger(cols) || cols < 20 || cols > 300 || !Number.isInteger(rows) || rows < 5 || rows > 120) {
      throw new Error('Terminal size must be 20-300 columns and 5-120 rows.');
    }
    if (cols === this.cols && rows === this.rows) return;
    if (this.child && (this.exitCode !== undefined || this.state === 'stopping')) throw new Error('OMP is stopping and cannot be resized.');
    try {
      this.child?.resize(cols, rows);
      this.terminal.resize(cols, rows);
      this.cols = cols;
      this.rows = rows;
      this.emit('status');
    } catch {
      this.fail('Cannot resize the OMP terminal. Check whether OMP has exited.');
      throw new Error('Cannot resize the OMP terminal.');
    }
  }

  private enqueueOutput(data: string): void {
    if (!data || this.overflow) return;
    const bytes = Buffer.byteLength(data, 'utf8');
    if (this.queuedBytes + bytes > MAX_QUEUE_BYTES) {
      this.overflow = true;
      this.fail('PTY output exceeded the bounded terminal queue despite backpressure. Output is incomplete; gracefully stop and resume OMP to rebuild the terminal.');
      return;
    }
    this.queuedBytes += bytes;
    this.outputQueue.push(data);
    if (!this.paused && this.queuedBytes >= PAUSE_BYTES && this.exitCode === undefined) {
      try { this.child?.pause(); this.paused = true; } catch { this.fail('PTY backpressure failed. Gracefully stop and restart OMP.'); }
    }
    this.pumpOutput();
  }

  private pumpOutput(): void {
    if (this.writing) return;
    const data = this.outputQueue.shift();
    if (data === undefined) { this.finishExit(); return; }
    this.writing = true;
    this.terminal.write(data, () => {
      this.writing = false;
      this.queuedBytes -= Buffer.byteLength(data, 'utf8');
      this.emit('data', data);
      if (this.paused && this.queuedBytes <= RESUME_BYTES && this.exitCode === undefined) {
        try { this.child?.resume(); this.paused = false; } catch { this.fail('Cannot resume PTY output after backpressure. Request a graceful stop.'); }
      }
      if (this.snapshotWaiters.length) {
        const snapshot = this.serializer.serialize({ scrollback: SCROLLBACK });
        const waiters = this.snapshotWaiters;
        this.snapshotWaiters = [];
        for (const resolveSnapshot of waiters) resolveSnapshot(snapshot);
        setImmediate(() => this.pumpOutput());
      } else {
        this.pumpOutput();
      }
    });
  }

  private readRuntime(): void {
    if (!this.child) return;
    try {
      const value = readObject(this.runtimeFile);
      if (!isSavedSession(value)) throw new Error('Invalid runtime metadata.');
      const runtime = value as RuntimeMetadata;
      if (runtime.runId !== this.runId) return;
      if (!Number.isSafeInteger(runtime.pid) || runtime.pid <= 0) throw new Error('Invalid runtime process identity.');
      this.runtimePid = runtime.pid;
      if (runtime.phase !== 'ready' && runtime.phase !== 'shutdown') throw new Error('Invalid runtime phase.');
      this.runtimeShutdown = runtime.phase === 'shutdown';
      const changed = this.cwd !== runtime.cwd || this.sessionFile !== runtime.sessionFile || this.sessionId !== runtime.sessionId;
      this.cwd = runtime.cwd;
      this.sessionFile = runtime.sessionFile;
      this.sessionId = runtime.sessionId;
      this.explicitResume = undefined;
      if (runtime.error) {
        this.fail(runtime.error);
      } else if (runtime.phase === 'ready' && this.state === 'starting' && this.exitCode === undefined) {
        this.state = 'running';
        this.emit('status');
      } else if (changed) {
        this.emit('status');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.fail('Cannot read OMP runtime metadata. Check private data directory permissions; the native process may still be active.');
    }
  }

  private cleanExit(): boolean {
    return this.exitCode === 0 || (this.requestedStop && this.runtimeShutdown && this.exitCode === 143);
  }

  private finishExit(): void {
    if (!this.child || this.exitCode === undefined || this.writing || this.outputQueue.length) return;
    try {
      if (this.runtimePid !== undefined && this.runtimePid !== this.child.pid && processIsAlive(this.runtimePid)) {
        this.fail('The original PTY process exited but a replacement OMP process is still alive. Do not resume its transcript elsewhere; request a graceful stop.');
        return;
      }
    } catch {
      this.fail('Cannot confirm that the replacement OMP process exited. Do not resume the transcript elsewhere until its process state is known.');
      return;
    }
    clearInterval(this.metadataTimer);
    this.metadataTimer = undefined;
    const code = this.exitCode;
    if (this.state === 'stopping' && this.cleanExit() && !this.overflow) this.error = undefined;
    this.child = undefined;
    try { removeIfPresent(this.stopFile); removeIfPresent(this.processFile); } catch {
      this.error = 'OMP exited, but its control files could not be removed. Check private data directory permissions before starting.';
    }
    if (this.nativeOwner && this.options.managed) {
      try { releaseNative(this.options.managed.lockDir, this.nativeOwner); } catch {
        this.error = 'OMP exited, but its native ownership locks could not be removed. Check private data directory permissions before starting.';
      }
    }
    if (!this.cleanExit()) this.error = `OMP exited with code ${code}. Inspect the terminal output before resuming the native transcript.`;
    this.state = this.error ? 'error' : 'stopped';
    this.emit('status');
    this.emit('exit');
  }

  private fail(message: string, stopping = false): void {
    const state = stopping ? 'stopping' : 'error';
    if (this.state === state && this.error === message) return;
    this.error = message;
    this.state = state;
    this.emit('status');
  }

  private waitFor(predicate: () => boolean, timeoutMessage: string, stopping = false): Promise<void> {
    const { promise, resolve: resolveWait, reject: rejectWait } = Promise.withResolvers<void>();
    const cleanup = () => { clearTimeout(timer); this.off('status', check); };
    const check = () => {
      try {
        if (predicate()) { cleanup(); resolveWait(); }
      } catch (error) { cleanup(); rejectWait(error); }
    };
    const timer = setTimeout(() => {
      cleanup();
      this.fail(timeoutMessage, stopping);
      rejectWait(new Error(timeoutMessage));
    }, LIFECYCLE_TIMEOUT);
    this.on('status', check);
    check();
    return promise;
  }
}
