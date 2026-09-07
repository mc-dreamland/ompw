import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { HostedSession, type SessionStatus } from './session.ts';
import { assertHostExited, canonicalPath, nativeKeys, readMetadata, type SavedSession } from './omp-extension.ts';

const MAX_RUNNING = 16;
const MAX_SESSIONS = 256;
const MAX_NATIVE_FILES = 20_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ManagedSessionStatus extends SessionStatus {
  id: string;
  name: string;
  createdAt: string;
}
interface RecordEntry extends SavedSession {
  id: string;
  name: string;
  createdAt: string;
  stateDir: string;
}
interface ManagedEntry {
  record: RecordEntry;
  host: HostedSession;
  starting?: Promise<void>;
  orphanError?: string;
}
interface NativeSession extends SavedSession { sessionFile: string; modified: number }

function savedSession(value: unknown): value is SavedSession {
  if (!value || typeof value !== 'object') return false;
  const saved = value as SavedSession;
  return typeof saved.cwd === 'string' && isAbsolute(saved.cwd)
    && (saved.sessionFile === null || (typeof saved.sessionFile === 'string' && isAbsolute(saved.sessionFile)))
    && (saved.sessionId === null || typeof saved.sessionId === 'string');
}

function atomicWrite(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

function nativeRoot(): string {
  const profile = (process.env.OMP_PROFILE ?? process.env.PI_PROFILE)?.trim();
  if (profile && profile !== 'default' && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(profile)) throw new Error('Invalid OMP profile name.');
  let config = join(homedir(), process.env.PI_CONFIG_DIR || '.omp');
  if (profile && profile !== 'default') config = join(config, 'profiles', profile);
  const agentDir = profile && profile !== 'default' ? join(config, 'agent') : resolve(process.env.PI_CODING_AGENT_DIR || join(config, 'agent'));
  if (process.platform !== 'win32' && !process.env.PI_CODING_AGENT_DIR && process.env.XDG_DATA_HOME) {
    const xdg = profile && profile !== 'default' ? join(process.env.XDG_DATA_HOME, 'omp', 'profiles', profile) : join(process.env.XDG_DATA_HOME, 'omp');
    if (existsSync(xdg)) return join(xdg, 'sessions');
  }
  return join(agentDir, 'sessions');
}

function nativeDirectory(cwd: string): string {
  const canonical = canonicalPath(cwd);
  const homeRelative = relative(canonicalPath(homedir()), canonical);
  const tempRelative = relative(canonicalPath(tmpdir()), canonical);
  const within = (path: string) => path === '' || (!path.startsWith('..') && !isAbsolute(path));
  const encode = (path: string) => path.replace(/[/\\:]/g, '-');
  const bucket = within(homeRelative) ? `-${encode(homeRelative)}`
    : within(tempRelative) ? `-tmp${tempRelative ? `-${encode(tempRelative)}` : ''}`
      : `--${encode(canonical.replace(/^[/\\]/, ''))}--`;
  return join(nativeRoot(), bucket);
}

function readNative(path: string): NativeSession {
  const fd = openSync(path, 'r');
  try {
    const prefix = Buffer.alloc(32 * 1024);
    const size = readSync(fd, prefix, 0, prefix.length, 0);
    for (const line of prefix.toString('utf8', 0, size).split('\n')) {
      let value: { type?: unknown; id?: unknown; cwd?: unknown };
      try { value = JSON.parse(line); } catch { continue; }
      if (!value || typeof value !== 'object' || value.type !== 'session') continue;
      if (typeof value.id !== 'string' || !value.id || typeof value.cwd !== 'string' || !isAbsolute(value.cwd)) break;
      return { sessionFile: resolve(path), sessionId: value.id, cwd: value.cwd, modified: statSync(path).mtimeMs };
    }
    throw new Error(`Cannot resume ${path}: its native session header is missing or malformed. The file was not modified.`);
  } finally { closeSync(fd); }
}

function resolveResume(target: string, cwd: string): NativeSession {
  if (!target.trim()) throw new Error('--resume requires a native session ID or JSONL path.');
  if (/[/\\]/.test(target) || target.toLowerCase().endsWith('.jsonl')) return readNative(resolve(cwd, target));
  const key = target.toLowerCase();
  const root = nativeRoot();
  const local: NativeSession[] = [];
  const global: NativeSession[] = [];
  let count = 0;
  let buckets: string[];
  try { buckets = readdirSync(root); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`Native OMP session "${target}" was not found in ${root}.`);
    throw error;
  }
  for (const bucket of buckets) {
    const directory = join(root, bucket);
    if (!statSync(directory).isDirectory()) continue;
    for (const file of readdirSync(directory)) {
      if (!file.toLowerCase().endsWith('.jsonl')) continue;
      if (++count > MAX_NATIVE_FILES) throw new Error('Native session search exceeds 20,000 files. Use --resume with the exact JSONL path.');
      let session: NativeSession;
      try { session = readNative(join(directory, file)); } catch { continue; }
      const name = basename(file, '.jsonl').toLowerCase();
      const suffix = name.slice(name.lastIndexOf('_') + 1);
      if (!session.sessionId?.toLowerCase().startsWith(key) && !name.startsWith(key) && !suffix.startsWith(key)) continue;
      (canonicalPath(session.cwd) === canonicalPath(cwd) ? local : global).push(session);
    }
  }
  const match = (local.length ? local : global).sort((left, right) => right.modified - left.modified)[0];
  if (!match) throw new Error(`Native OMP session "${target}" was not found in ${root}. Use an exact JSONL path for a custom session directory.`);
  return match;
}

export class SessionRegistry extends EventEmitter {
  private readonly dataDir: string;
  private readonly ompPath: string;
  private readonly inventoryFile: string;
  private readonly lockDir: string;
  private readonly entries = new Map<string, ManagedEntry>();
  private initialized = false;
  private closing = false;

  constructor(options: { dataDir: string; ompPath: string }) {
    super();
    this.dataDir = resolve(options.dataDir);
    this.ompPath = options.ompPath;
    this.inventoryFile = join(this.dataDir, 'sessions.json');
    this.lockDir = join(this.dataDir, 'native-locks');
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.lockDir, { recursive: true, mode: 0o700 });
    let records: RecordEntry[] = [];
    try {
      if (statSync(this.inventoryFile).size > 2 * 1024 * 1024) throw new Error('Session inventory exceeds its size limit.');
      const saved = JSON.parse(readFileSync(this.inventoryFile, 'utf8')) as { version?: unknown; sessions?: unknown };
      if (saved.version !== 1 || !Array.isArray(saved.sessions) || saved.sessions.length > MAX_SESSIONS) throw new Error('Invalid session inventory. Restore sessions.json before starting the daemon.');
      for (const value of saved.sessions) {
        const record = value as RecordEntry;
        if (!savedSession(record) || typeof record.id !== 'string' || !UUID.test(record.id)
          || typeof record.name !== 'string' || typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt))
          || typeof record.stateDir !== 'string' || !/^(?:hosts\/[0-9a-f-]{36}|workspaces\/[0-9a-f]{64})$/i.test(record.stateDir)
          || records.some(existing => existing.id === record.id || existing.stateDir === record.stateDir)) throw new Error('Invalid session inventory entry. Restore sessions.json before starting the daemon.');
        records.push(record);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const legacyRoot = join(this.dataDir, 'workspaces');
    let legacy: string[] = [];
    try { legacy = readdirSync(legacyRoot); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    for (const name of legacy) {
      if (!/^[0-9a-f]{64}$/i.test(name) || records.some(record => record.stateDir === `workspaces/${name}`)) continue;
      const directory = join(legacyRoot, name);
      let saved: unknown;
      try { saved = readMetadata(join(directory, 'last-session.json')); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        // Never discard a marker just because a child died before its first publish.
        assertHostExited(directory);
        continue;
      }
      if (!savedSession(saved)) throw new Error(`Invalid legacy session metadata in ${directory}. Repair it before starting the daemon.`);
      if (records.length >= MAX_SESSIONS) throw new Error('The hosted inventory is limited to 256 sessions. Archive stopped session metadata before migrating more.');
      records.push({ ...saved, id: randomUUID(), name: basename(saved.cwd) || saved.cwd, createdAt: statSync(join(directory, 'last-session.json')).mtime.toISOString(), stateDir: `workspaces/${name}` });
    }
    for (const record of records) this.add(record);
    this.persist();
    this.initialized = true;
    this.emit('changed');
  }

  list(): ManagedSessionStatus[] {
    return [...this.entries.values()].map(entry => this.describeEntry(entry));
  }

  get(id: string): HostedSession | undefined { return this.entries.get(id)?.host; }

  describe(id: string): ManagedSessionStatus | undefined {
    const entry = this.entries.get(id);
    return entry ? this.describeEntry(entry) : undefined;
  }

  async register(options: { cwd: string; newSession?: boolean; resume?: string }): Promise<ManagedSessionStatus> {
    this.assertAvailable();
    if (options.newSession && options.resume) throw new Error('--new and --resume cannot be combined.');
    const cwd = canonicalPath(options.cwd);
    if (!statSync(cwd).isDirectory()) throw new Error(`Working directory is not a directory: ${cwd}`);
    let native: NativeSession | undefined;
    if (options.resume) native = resolveResume(options.resume, cwd);
    let existing: ManagedEntry | undefined;
    if (native) {
      const keys = new Set(nativeKeys(native.sessionFile));
      existing = [...this.entries.values()].find(entry => {
        const file = entry.host.status().sessionFile;
        return file && nativeKeys(file).some(key => keys.has(key));
      });
      if (existing?.host.isActive() || existing?.starting) throw new Error(`Native session is already hosted by ${existing.record.id}. Select that session or stop it before explicitly resuming it.`);
    } else if (!options.newSession) {
      existing = [...this.entries.values()].find(entry => canonicalPath(entry.host.status().cwd) === cwd);
    }
    if (existing) {
      this.ensureStart(existing, cwd);
      if (existing.starting) await existing.starting;
      return this.describeEntry(existing);
    }
    if (this.entries.size >= MAX_SESSIONS) throw new Error('The hosted inventory is limited to 256 sessions. Archive stopped session metadata before registering more.');
    this.assertCapacity();
    const id = randomUUID();
    const sessionFile = native?.sessionFile ?? join(nativeDirectory(cwd), `${new Date().toISOString().replace(/[:.]/g, '-')}_${randomUUID()}.jsonl`);
    const projectCwd = native?.cwd ?? cwd;
    const siblingCount = [...this.entries.values()].filter(entry => canonicalPath(entry.host.status().cwd) === canonicalPath(projectCwd)).length;
    const projectName = basename(projectCwd) || projectCwd;
    const record: RecordEntry = {
      id, name: siblingCount ? `${projectName} (${siblingCount + 1})` : projectName, cwd: projectCwd,
      sessionFile, sessionId: native?.sessionId ?? null,
      createdAt: new Date().toISOString(), stateDir: `hosts/${id}`,
    };
    const entry = this.add(record);
    this.persist();
    this.emit('changed');
    this.ensureStart(entry, cwd);
    if (entry.starting) await entry.starting;
    return this.describeEntry(entry);
  }

  async start(id: string): Promise<ManagedSessionStatus> {
    this.assertAvailable();
    const entry = this.requireEntry(id);
    this.ensureStart(entry);
    return this.describeEntry(entry);
  }

  async stop(id: string): Promise<ManagedSessionStatus> {
    const entry = this.requireEntry(id);
    if (entry.orphanError) {
      assertHostExited(join(this.dataDir, entry.record.stateDir));
      entry.orphanError = undefined;
      this.emit('changed');
    }
    await entry.host.stop();
    return this.describeEntry(entry);
  }

  async stopAll(): Promise<void> {
    this.closing = true;
    const results = await Promise.allSettled([...this.entries.values()].map(async entry => {
      if (entry.orphanError) {
        assertHostExited(join(this.dataDir, entry.record.stateDir));
        entry.orphanError = undefined;
        this.emit('changed');
      }
      await entry.host.stop();
    }));
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.length) {
      this.closing = false;
      throw new AggregateError(failures.map(result => result.reason), 'Some OMP processes have not completed graceful release. The daemon must remain alive; retry Stop after those sessions settle.');
    }
  }

  private assertAvailable(): void {
    if (!this.initialized) throw new Error('Session registry has not been initialized.');
    if (this.closing) throw new Error('The daemon is stopping; new sessions cannot be started.');
  }

  private assertCapacity(): void {
    // An orphan may be an older bridge with no in-TUI ownership guard. No new
    // writers can start until every orphan's actual process exit is confirmed.
    for (const entry of this.entries.values()) {
      if (!entry.orphanError) continue;
      assertHostExited(join(this.dataDir, entry.record.stateDir));
      entry.orphanError = undefined;
      this.emit('changed');
    }
    if ([...this.entries.values()].filter(entry => entry.host.isActive() || entry.starting || entry.orphanError).length >= MAX_RUNNING) throw new Error('At most 16 OMP sessions may run concurrently. Stop a session before starting another.');
  }

  private requireEntry(id: string): ManagedEntry {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Hosted session ${id} was not found.`);
    return entry;
  }

  private ensureStart(entry: ManagedEntry, fallbackCwd?: string): void {
    if (entry.starting || entry.host.isActive()) return;
    assertHostExited(join(this.dataDir, entry.record.stateDir));
    entry.orphanError = undefined;
    this.assertCapacity();
    const operation = entry.host.start(fallbackCwd);
    entry.starting = operation;
    void operation.finally(() => { entry.starting = undefined; this.emit('changed'); }).catch(() => {});
  }

  private add(record: RecordEntry): ManagedEntry {
    const hostDir = join(this.dataDir, record.stateDir);
    mkdirSync(hostDir, { recursive: true, mode: 0o700 });
    let saved: SavedSession = record;
    try {
      const latest = readMetadata(join(hostDir, 'last-session.json'));
      if (!savedSession(latest)) throw new Error(`Invalid saved native session metadata in ${hostDir}.`);
      saved = latest;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (!saved.sessionFile) {
      saved = { ...saved, sessionFile: join(nativeDirectory(saved.cwd), `${new Date().toISOString().replace(/[:.]/g, '-')}_${randomUUID()}.jsonl`) };
    }
    const host = new HostedSession({ cwd: saved.cwd, dataDir: hostDir, ompPath: this.ompPath, saved, managed: { id: record.id, lockDir: this.lockDir } });
    const entry: ManagedEntry = { record: { ...record, ...saved }, host };
    try { assertHostExited(hostDir); } catch (error) {
      entry.orphanError = error instanceof Error ? error.message : 'Cannot confirm previous native process exit.';
    }
    this.entries.set(record.id, entry);
    host.on('status', () => { this.persist(); this.emit('changed'); });
    return entry;
  }

  private describeEntry(entry: ManagedEntry): ManagedSessionStatus {
    return { ...entry.host.status(), id: entry.record.id, name: entry.record.name, createdAt: entry.record.createdAt,
      ...(entry.orphanError ? { state: 'error' as const, error: entry.orphanError } : {}) };
  }

  private persist(): void {
    const sessions = [...this.entries.values()].map(entry => {
      const { cwd, sessionFile, sessionId } = entry.host.status();
      return { ...entry.record, cwd, sessionFile, sessionId };
    });
    atomicWrite(this.inventoryFile, { version: 1, sessions });
  }
}
