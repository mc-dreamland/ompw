import { normalizeOtp } from '../otp.ts';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { createIcons, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, Copy, CornerDownLeft, Keyboard, LogOut, PanelLeft, Play, RefreshCw, Square, Unplug, X } from 'lucide';
import '@xterm/xterm/css/xterm.css';
import './style.css';

type SessionStatus = {
  id: string;
  name: string;
  createdAt: string;
  state: 'starting' | 'running' | 'stopping' | 'stopped' | 'error';
  cwd: string;
  sessionFile: string | null;
  sessionId: string | null;
  cols: number;
  rows: number;
  error?: string;
};
type ServerMessage =
  | { type: 'snapshot'; id: string; data: string; cols: number; rows: number; controller: boolean }
  | { type: 'output'; id: string; data: string }
  | { type: 'status'; session: SessionStatus; controller: boolean }
  | { type: 'sessions'; sessions: SessionStatus[] }
  | { type: 'error'; message: string };

const root = document.querySelector<HTMLElement>('#app')!;
const icons = { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, Copy, CornerDownLeft, Keyboard, LogOut, PanelLeft, Play, RefreshCw, Square, Unplug, X };
const stateNames = { starting: '启动中', running: '运行中', stopping: '正在释放', stopped: '已停止', error: '进程异常' };
const MAX_WRITE_CHARS = 16 * 1024 * 1024;
const MAX_WRITE_ENTRIES = 4096;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function icon(name: string): HTMLElement {
  const node = element('i');
  node.dataset.lucide = name;
  node.setAttribute('aria-hidden', 'true');
  return node;
}

function button(label: string, iconName: string, action: () => void, className = 'icon-button'): HTMLButtonElement {
  const node = element('button', className);
  node.type = 'button';
  node.title = label;
  node.setAttribute('aria-label', label);
  node.append(icon(iconName));
  if (className.includes('text-button')) node.append(element('span', '', label));
  node.addEventListener('click', action);
  return node;
}

function renderIcons(): void {
  createIcons({ icons, attrs: { 'stroke-width': 1.7, 'aria-hidden': 'true' } });
}

let epoch = 0;
let connection = 0;
let csrf = '';
let socket: WebSocket | null = null;
let terminal: Terminal | null = null;
let fit: FitAddon | null = null;
let observer: ResizeObserver | null = null;
let retryTimer: number | undefined;
let resizeFrame = 0;
let retryCount = 0;
let sentCols = 0;
let sentRows = 0;
let controller = false;
let snapshotReady = false;
let online = false;
let busy = false;
let session: SessionStatus | null = null;
let sessions: SessionStatus[] = [];
let selectedId: string | null = null;
let requestedId = new URL(location.href).searchParams.get('session');
let catalogLoaded = false;
let catalogRevision = 0;
let catalogRequest = 0;
let pollTimer: number | undefined;
let copyTimer: number | undefined;
let stopTargetId: string | null = null;
let drawerOpen = false;
let writeQueue: Array<{ data: string; setup?: () => void; complete?: () => void }> = [];
let queuedChars = 0;
let writing = false;
let loginForm: HTMLFormElement;
let passwordInput: HTMLInputElement;
let codeInput: HTMLInputElement;
let loginError: HTMLElement;
let loginSubmit: HTMLButtonElement;
let appView: HTMLElement;
let sessionList: HTMLElement;
let catalogCount: HTMLElement;
let sidebarToggle: HTMLButtonElement;
let selectedLabel: HTMLElement;
let emptyState: HTMLElement;
let terminalFooter: HTMLElement;
let stopTargetLabel: HTMLElement;
let copyButton: HTMLButtonElement;
let connectionLabel: HTMLElement;
let processLabel: HTMLElement;
let cwdLabel: HTMLElement;
let fileLabel: HTMLElement;
let appError: HTMLElement;
let terminalMount: HTMLElement;
let terminalWrap: HTMLElement;
let ownershipButton: HTMLButtonElement;
let startButton: HTMLButtonElement;
let stopButton: HTMLButtonElement;
let logoutButton: HTMLButtonElement;
let reconnectButton: HTMLButtonElement;
let nativeRow: HTMLElement;
let nativeCommand: HTMLElement;
let stopDialog: HTMLDialogElement;
let stopConfirm: HTMLButtonElement;
const keyButtons: HTMLButtonElement[] = [];

function cancelConnection(): void {
  connection++;
  clearTimeout(retryTimer);
  retryTimer = undefined;
  cancelAnimationFrame(resizeFrame);
  online = false;
  controller = false;
  snapshotReady = false;
  sentCols = 0;
  sentRows = 0;
  const old = socket;
  socket = null;
  old?.close();
}

function showLogin(message = '', preserveRequested = false): void {
  epoch++;
  cancelConnection();
  csrf = '';
  session = null;
  sessions = [];
  selectedId = null;
  catalogLoaded = false;
  catalogRevision++;
  catalogRequest++;
  clearTimeout(pollTimer);
  clearTimeout(copyTimer);
  pollTimer = undefined;
  copyTimer = undefined;
  stopTargetId = null;
  drawerOpen = false;
  if (!preserveRequested) {
    requestedId = null;
    updateSelectedUrl(null);
  }
  busy = false;
  retryCount = 0;
  observer?.disconnect();
  observer = null;
  cancelAnimationFrame(resizeFrame);
  terminal?.dispose();
  terminal = null;
  fit = null;
  clearWrites();
  stopDialog?.close();
  if (passwordInput) passwordInput.value = '';
  if (codeInput) codeInput.value = '';
  for (const node of [terminalMount, cwdLabel, fileLabel, nativeCommand, appError, sessionList, selectedLabel, catalogCount, stopTargetLabel]) {
    if (node) { node.replaceChildren(); node.removeAttribute('title'); }
  }
  root.replaceChildren();
  keyButtons.length = 0;
  const view = element('section', 'login-view');
  const heading = element('header', 'login-heading');
  heading.append(element('div', 'brand', 'ompw'), element('h1', '', '登录终端'));
  loginForm = element('form', 'login-form');
  loginForm.noValidate = true;
  const passwordLabel = element('label', '', '管理员密码');
  passwordLabel.htmlFor = 'password';
  passwordInput = element('input');
  passwordInput.id = 'password';
  passwordInput.name = 'password';
  passwordInput.type = 'password';
  passwordInput.autocomplete = 'current-password';
  passwordInput.required = true;
  const codeLabel = element('label', '', '动态验证码');
  codeLabel.htmlFor = 'code';
  codeInput = element('input', 'code-input');
  codeInput.id = 'code';
  codeInput.name = 'code';
  codeInput.type = 'text';
  codeInput.inputMode = 'numeric';
  codeInput.autocomplete = 'one-time-code';
  codeInput.pattern = '[0-9]{6}';
  codeInput.maxLength = 16;
  codeInput.required = true;
  loginError = element('p', 'form-error', message);
  loginError.setAttribute('role', 'alert');
  loginSubmit = element('button', 'primary text-button', '登录');
  loginSubmit.type = 'submit';
  loginForm.append(passwordLabel, passwordInput, codeLabel, codeInput, loginError, loginSubmit);
  loginForm.addEventListener('submit', (event) => { event.preventDefault(); void login(); });
  view.append(heading, loginForm);
  root.append(view);
  passwordInput.focus();
}

async function login(): Promise<void> {
  const normalized = normalizeOtp(codeInput.value);
  if (normalized) codeInput.value = normalized;
  if (busy || !loginForm.reportValidity()) return;
  busy = true;
  const current = epoch;
  loginSubmit.disabled = true;
  loginSubmit.textContent = '正在登录…';
  loginError.textContent = '';
  try {
    const response = await fetch('/api/login', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: passwordInput.value, code: codeInput.value }),
    });
    const result = await response.json() as { csrf?: string };
    if (current !== epoch) return;
    if (!response.ok || !result.csrf) {
      const failure = result as { code?: string; retryAfter?: number };
      if (response.status === 429) {
        const seconds = Number(response.headers.get('Retry-After') || 300);
        throw new Error(`登录尝试过多，请等待 ${Number.isFinite(seconds) ? Math.max(1, Math.ceil(seconds)) : 300} 秒后重试。`);
      }
      if (failure.code === 'OTP_REUSED') throw new Error('此动态码已用于绑定或登录，请等待验证器显示下一个新码。');
      if (response.status === 403) throw new Error('访问地址校验失败，请使用启动时显示的地址，或检查 --origin 配置。');
      if (response.status !== 401) throw new Error('登录服务暂不可用，请稍后重试。');
      throw new Error('密码或动态验证码不正确。请使用验证器中 ompw 的当前验证码，并确认手机时间自动同步。');
    }
    passwordInput.value = '';
    codeInput.value = '';
    csrf = result.csrf;
    busy = false;
    showTerminal();
    startCatalog();
  } catch (error) {
    if (current !== epoch) return;
    loginError.textContent = error instanceof Error ? error.message : '无法连接登录服务，请稍后重试。';
    codeInput.value = '';
    codeInput.focus();
  } finally {
    if (current === epoch) {
      busy = false;
      loginSubmit.disabled = false;
      loginSubmit.textContent = '登录';
    }
  }
}

function showTerminal(): void {
  epoch++;
  root.replaceChildren();
  appView = element('section', 'workspace');
  const header = element('header', 'toolbar');
  const identity = element('div', 'identity');
  sidebarToggle = button('会话列表', 'panel-left', () => setDrawer(!drawerOpen), 'icon-button sidebar-toggle');
  sidebarToggle.setAttribute('aria-controls', 'session-sidebar');
  sidebarToggle.setAttribute('aria-expanded', 'false');
  connectionLabel = element('span', 'connection');
  connectionLabel.setAttribute('role', 'status');
  processLabel = element('span', 'process-state');
  selectedLabel = element('span', 'selected-session');
  identity.append(sidebarToggle, element('h1', 'brand', 'ompw'), selectedLabel, connectionLabel, processLabel);
  const actions = element('nav', 'toolbar-actions');
  actions.setAttribute('aria-label', '终端操作');
  ownershipButton = button('获取输入控制', 'keyboard', toggleOwnership, 'text-button');
  startButton = button('启动 OMP', 'play', () => { void changeSession('start'); }, 'text-button');
  stopButton = button('释放 OMP', 'unplug', openStopDialog, 'text-button');
  reconnectButton = button('重新连接', 'refresh-cw', () => {
    retryCount = 0;
    if (selectedId) void connect();
    void refreshCatalog();
  });
  logoutButton = button('退出登录', 'log-out', () => { void logout(); });
  actions.append(ownershipButton, startButton, stopButton, reconnectButton, logoutButton);
  header.append(identity, actions);
  const body = element('div', 'workspace-body');
  const sidebar = element('aside', 'session-sidebar');
  sidebar.id = 'session-sidebar';
  sidebar.setAttribute('aria-label', 'OMP 会话');
  const catalogHeader = element('div', 'catalog-header');
  catalogCount = element('span', 'catalog-count');
  catalogCount.setAttribute('role', 'status');
  catalogHeader.append(element('h2', '', '会话'), catalogCount);
  sessionList = element('nav', 'session-list');
  sessionList.setAttribute('aria-label', '选择会话');
  sidebar.append(catalogHeader, sessionList);
  const pane = element('main', 'session-pane');
  const details = element('div', 'session-details');
  cwdLabel = element('span', 'detail-value', '—');
  fileLabel = element('span', 'detail-value', '—');
  const cwdRow = element('div', 'detail-row');
  cwdRow.append(element('span', 'detail-label', '目录'), cwdLabel);
  const fileRow = element('div', 'detail-row');
  fileRow.append(element('span', 'detail-label', '会话'), fileLabel);
  details.append(cwdRow, fileRow);
  appError = element('div', 'app-error');
  appError.setAttribute('role', 'alert');
  appError.hidden = true;
  emptyState = element('div', 'empty-state', '正在读取会话…');
  emptyState.setAttribute('role', 'status');
  terminalWrap = element('div', 'terminal-wrap');
  terminalWrap.setAttribute('aria-label', '所选会话终端');
  terminalMount = element('div', 'terminal-mount');
  terminalWrap.append(terminalMount);
  terminalFooter = element('footer', 'terminal-footer');
  const keys = element('nav', 'terminal-keys');
  keys.setAttribute('aria-label', '终端按键');
  const keySpecs: [string, string, string][] = [
    ['Escape', 'x', '\u001b'], ['Tab', 'corner-down-left', '\t'],
    ['向上', 'arrow-up', '\u001b[A'], ['向下', 'arrow-down', '\u001b[B'],
    ['向左', 'arrow-left', '\u001b[D'], ['向右', 'arrow-right', '\u001b[C'],
    ['Ctrl+C · 中断', 'square', '\u0003'],
  ];
  for (const [label, image, value] of keySpecs) {
    const key = button(label, image, () => { sendInput(value); terminal?.focus(); });
    key.addEventListener('pointerdown', (event) => event.preventDefault());
    keyButtons.push(key);
    keys.append(key);
  }
  nativeRow = element('div', 'native-resume');
  nativeRow.hidden = true;
  nativeCommand = element('code', 'native-command');
  copyButton = button('复制恢复命令', 'copy', () => { void copyResume(copyButton); });
  nativeRow.append(nativeCommand, copyButton);
  terminalFooter.append(keys, nativeRow);
  stopDialog = element('dialog', 'confirm-dialog');
  stopDialog.setAttribute('aria-labelledby', 'stop-title');
  stopDialog.setAttribute('aria-describedby', 'stop-warning');
  const title = element('h2', '', '释放托管 OMP？');
  title.id = 'stop-title';
  const warning = element('p', '', '这会中断正在运行的任务并关闭托管进程。退出完成后，才能在本机恢复此会话。');
  warning.id = 'stop-warning';
  stopTargetLabel = element('p', 'stop-target');
  const dialogActions = element('div', 'dialog-actions');
  const cancel = button('取消', 'x', () => stopDialog.close(), 'text-button');
  stopConfirm = button('释放 OMP', 'unplug', () => { void changeSession('stop', stopTargetId); }, 'danger text-button');
  stopDialog.addEventListener('close', () => { stopTargetId = null; });
  dialogActions.append(cancel, stopConfirm);
  stopDialog.append(title, warning, stopTargetLabel, dialogActions);
  pane.append(details, appError, emptyState, terminalWrap, terminalFooter);
  body.append(sidebar, pane);
  appView.append(header, body, stopDialog);
  root.append(appView);
  appView.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && drawerOpen) { setDrawer(false); sidebarToggle.focus(); }
  });
  observer = new ResizeObserver(scheduleFit);
  observer.observe(terminalWrap);
  renderCatalog();
  renderIcons();
  updateUI();
}

function resetTerminal(): void {
  terminal?.dispose();
  terminal = null;
  fit = null;
  clearWrites();
  terminalMount.replaceChildren();
  terminalMount.style.width = '100%';
  terminalMount.style.height = '100%';
  terminalWrap.scrollTop = 0;
  terminalWrap.scrollLeft = 0;
  if (!selectedId) return;
  terminal = new Terminal({
    cols: 100, rows: 30, scrollback: 5000, fontSize: 14,
    fontFamily: '"Cascadia Mono", "SFMono-Regular", Consolas, "Liberation Mono", monospace',
    cursorBlink: false, disableStdin: true, convertEol: false,
    theme: { background: '#101312', foreground: '#dce2dd', cursor: '#86d9aa', selectionBackground: '#345344', black: '#202622', red: '#ef8585', green: '#86d9aa', yellow: '#ddcf8a', blue: '#8ab8df', magenta: '#c8a5df', cyan: '#87ccd0', white: '#dce2dd', brightBlack: '#78857d', brightRed: '#ffabab', brightGreen: '#a5edc2', brightYellow: '#f0dfa0', brightBlue: '#a8d1f1', brightMagenta: '#ddbef0', brightCyan: '#a7e5e5', brightWhite: '#ffffff' },
  });
  fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.open(terminalMount);
  const target = terminal;
  const current = connection;
  terminal.onData((data) => {
    if (target !== terminal || current !== connection) return;
    // The headless host owns device, cursor, mode, and status-string replies.
    if (/^\u001b(?:\[(?:[?>][0-9;]*c|\??[0-9]+;[0-9]+R|[0-9]+n|\??[0-9]+;[0-9]+\$y|8;[0-9]+;[0-9]+t)|P[01]\$r[\s\S]*\u001b\\)$/.test(data)) return;
    sendInput(data);
  });
  updateUI();
}

function setDrawer(open: boolean): void {
  drawerOpen = open;
  appView.classList.toggle('drawer-open', open);
  sidebarToggle.setAttribute('aria-expanded', String(open));
  scheduleFit();
}

function updateSelectedUrl(id: string | null): void {
  const url = new URL(location.href);
  if (id) url.searchParams.set('session', id);
  else url.searchParams.delete('session');
  history.replaceState(null, '', url);
}

function selectSession(id: string | null): void {
  if (id === selectedId) return;
  cancelConnection();
  selectedId = id;
  session = sessions.find(item => item.id === id) || null;
  retryCount = 0;
  clearTimeout(copyTimer);
  copyButton.replaceChildren(icon('copy'));
  copyButton.title = '复制恢复命令';
  copyButton.setAttribute('aria-label', '复制恢复命令');
  renderIcons();
  updateSelectedUrl(id);
  showError(session?.error || '');
  if (!id) resetTerminal();
  renderCatalog();
  updateUI();
  if (id) void connect();
}

function renderCatalog(): void {
  const active = sessions.filter(item => item.state === 'starting' || item.state === 'running').length;
  catalogCount.textContent = `${sessions.length} 个 · ${active} 运行`;
  const existing = new Map(Array.from(sessionList.querySelectorAll<HTMLButtonElement>('.session-item'), node => [node.dataset.id!, node]));
  sessionList.querySelector('.catalog-empty')?.remove();
  for (const item of sessions) {
    let node = existing.get(item.id);
    if (!node) {
      node = element('button', 'session-item');
      node.type = 'button';
      node.dataset.id = item.id;
      node.append(element('span', 'session-name'), element('span', 'session-state'), element('span', 'session-cwd'));
      node.addEventListener('click', () => {
        requestedId = null;
        selectSession(item.id);
        setDrawer(false);
      });
    }
    existing.delete(item.id);
    node.querySelector('.session-name')!.textContent = item.name;
    node.querySelector('.session-state')!.textContent = stateNames[item.state];
    node.querySelector('.session-cwd')!.textContent = item.cwd;
    node.dataset.state = item.state;
    node.setAttribute('aria-current', String(item.id === selectedId));
    node.setAttribute('aria-label', `${item.name}，${item.cwd}，${stateNames[item.state]}`);
    node.title = `${item.name}\n${item.cwd}\n${stateNames[item.state]}`;
    if (node.parentElement !== sessionList) sessionList.append(node);
  }
  for (const node of existing.values()) node.remove();
  if (!sessions.length) sessionList.append(element('p', 'catalog-empty', catalogLoaded ? '暂无会话' : '正在读取…'));
}

function applyCatalog(items: SessionStatus[]): void {
  catalogRevision++;
  catalogLoaded = true;
  sessions = items;
  let next = requestedId && items.some(item => item.id === requestedId) ? requestedId : selectedId;
  if (items.length) requestedId = null;
  if (!next || !items.some(item => item.id === next)) {
    next = items.find(item => item.state === 'running' || item.state === 'starting')?.id || items[0]?.id || null;
  }
  if (next !== selectedId) selectSession(next);
  else {
    const previousError = session?.error;
    session = items.find(item => item.id === next) || null;
    if (previousError !== session?.error) showError(session?.error || '');
    renderCatalog();
    updateUI();
  }
}

function updateSession(status: SessionStatus): void {
  const items = sessions.some(item => item.id === status.id)
    ? sessions.map(item => item.id === status.id ? status : item)
    : [...sessions, status];
  applyCatalog(items);
}

function startCatalog(): void {
  void refreshCatalog();
  const current = epoch;
  const poll = async () => {
    if (current !== epoch || !csrf) return;
    if (!socket || socket.readyState !== WebSocket.OPEN) await refreshCatalog();
    if (current === epoch && csrf) pollTimer = window.setTimeout(poll, 5000);
  };
  pollTimer = window.setTimeout(poll, 5000);
}

async function refreshCatalog(): Promise<void> {
  const current = epoch;
  const revision = catalogRevision;
  const request = ++catalogRequest;
  try {
    const response = await fetch('/api/sessions', { credentials: 'same-origin', cache: 'no-store' });
    if (current !== epoch) return;
    if (response.status === 401) { showLogin('登录已过期，请重新登录。'); return; }
    if (!response.ok) throw new Error('无法读取会话列表。');
    const result = await response.json() as { sessions: SessionStatus[] };
    if (current !== epoch || revision !== catalogRevision || request !== catalogRequest) return;
    if (!catalogLoaded) showError('');
    applyCatalog(result.sessions);
  } catch (error) {
    if (current === epoch && request === catalogRequest) showError(error instanceof Error ? error.message : '无法读取会话列表。');
  }
}

function openStopDialog(): void {
  if (!session || busy) return;
  stopTargetId = session.id;
  stopTargetLabel.textContent = `${session.name}\n${session.cwd}`;
  stopDialog.showModal();
  updateUI();
}

function showError(message: string): void {
  appError.textContent = message;
  appError.hidden = !message;
}

function updateUI(): void {
  if (!csrf) return;
  connectionLabel.textContent = session ? (online ? (controller ? '已连接 · 可输入' : '已连接 · 只读') : '连接已断开') : '已登录';
  connectionLabel.dataset.online = String(online);
  processLabel.textContent = session ? stateNames[session.state] : '';
  processLabel.dataset.state = session?.state || '';
  selectedLabel.textContent = session?.name || '';
  selectedLabel.title = session?.name || '';
  cwdLabel.textContent = session?.cwd || '—';
  cwdLabel.title = session?.cwd || '';
  fileLabel.textContent = session?.sessionFile || '—';
  fileLabel.title = session?.sessionFile || '';
  emptyState.hidden = !!session;
  emptyState.textContent = catalogLoaded ? '暂无托管会话' : '正在读取会话…';
  terminalWrap.hidden = !session;
  terminalFooter.hidden = !session;
  const label = controller ? '放弃输入控制' : '获取输入控制';
  ownershipButton.querySelector('span')!.textContent = label;
  ownershipButton.title = label;
  ownershipButton.setAttribute('aria-label', label);
  const acceptingInput = session?.state === 'running' || session?.state === 'starting';
  ownershipButton.disabled = !online || !snapshotReady || busy || !acceptingInput;
  startButton.hidden = session?.state !== 'stopped' && session?.state !== 'error';
  startButton.disabled = busy || !session;
  stopButton.hidden = !session || session.state === 'stopped';
  stopButton.disabled = busy || !session || (session.state === 'stopping' && !session.error);
  const stopTarget = sessions.find(item => item.id === stopTargetId);
  stopConfirm.disabled = busy || !stopTarget || stopTarget.state === 'stopped' || (stopTarget.state === 'stopping' && !stopTarget.error);
  logoutButton.disabled = busy;
  reconnectButton.disabled = busy;
  const disableStdin = !online || !controller || !snapshotReady || !acceptingInput;
  if (terminal) {
    terminal.options.disableStdin = disableStdin;
    terminal.options.cursorBlink = !disableStdin;
  }
  keyButtons.forEach(key => { key.disabled = disableStdin; });
  nativeRow.hidden = session?.state !== 'stopped' || !session.sessionFile;
  nativeCommand.textContent = nativeRow.hidden ? '' : `omp --resume "${session!.sessionFile!.replaceAll('"', '\\"')}"`;
  terminalWrap.classList.toggle('read-only', !controller);
}

function send(value: object): void {
  if (online && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
}

function sendInput(data: string): void {
  if (controller && snapshotReady && session && (session.state === 'running' || session.state === 'starting')) send({ type: 'input', data });
}

function toggleOwnership(): void {
  if (snapshotReady) send({ type: controller ? 'release' : 'claim' });
}

function scheduleFit(): void {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(fitTerminal);
}

function fitTerminal(): void {
  if (!terminal || !fit || !snapshotReady) return;
  if (controller && online) {
    terminalMount.style.width = '100%';
    terminalMount.style.height = '100%';
    const dimensions = fit.proposeDimensions();
    if (!dimensions) return;
    const cols = Math.max(20, Math.min(300, dimensions.cols));
    const rows = Math.max(5, Math.min(120, dimensions.rows));
    if (terminal.cols !== cols || terminal.rows !== rows) terminal.resize(cols, rows);
    if (sentCols !== cols || sentRows !== rows) {
      sentCols = cols;
      sentRows = rows;
      send({ type: 'resize', cols, rows });
    }
  } else {
    // Keep the host cell grid intact; narrow viewers scroll instead of reflowing it.
    const screen = terminalMount.querySelector<HTMLElement>('.xterm-screen');
    if (screen) {
      terminalMount.style.width = `${Math.ceil(screen.getBoundingClientRect().width) + 16}px`;
      terminalMount.style.height = `${Math.ceil(screen.getBoundingClientRect().height)}px`;
    }
  }
}

function clearWrites(): void {
  writeQueue = [];
  queuedChars = 0;
  writing = false;
}

function enqueueWrite(data: string, current: number, setup?: () => void, complete?: () => void): void {
  if (current !== connection || !terminal) return;
  if (queuedChars + data.length > MAX_WRITE_CHARS || writeQueue.length >= MAX_WRITE_ENTRIES) {
    cancelConnection();
    resetTerminal();
    showError('终端输出积压，正在重新同步。');
    reconnectLater(connection);
    return;
  }
  queuedChars += data.length;
  writeQueue.push({ data, setup, complete });
  pumpWrites(current);
}

function pumpWrites(current: number): void {
  if (writing || current !== connection || !terminal) return;
  const entry = writeQueue.shift();
  if (!entry) return;
  const target = terminal;
  writing = true;
  entry.setup?.();
  target.write(entry.data, () => {
    if (current !== connection || target !== terminal) return;
    queuedChars -= entry.data.length;
    writing = false;
    entry.complete?.();
    pumpWrites(current);
  });
}

function receive(message: ServerMessage, current: number): void {
  if (current !== connection) return;
  if (message.type === 'sessions') { applyCatalog(message.sessions); return; }
  if (!terminal) return;
  if (message.type === 'snapshot') {
    if (message.id !== selectedId) return;
    snapshotReady = false;
    controller = message.controller;
    updateUI();
    enqueueWrite(message.data, current, () => {
      terminal!.reset();
      terminal!.resize(message.cols, message.rows);
    }, () => {
      snapshotReady = true;
      retryCount = 0;
      updateUI();
      fitTerminal();
      if (controller) terminal?.focus();
    });
  } else if (message.type === 'output') {
    if (message.id !== selectedId) return;
    enqueueWrite(message.data, current);
  } else if (message.type === 'status') {
    if (message.session.id !== selectedId) return;
    const gainedControl = !controller && message.controller;
    controller = message.controller;
    updateSession(message.session);
    // Queue a grid update behind pending output so wrapping matches host order.
    const hostCols = message.session.cols;
    const hostRows = message.session.rows;
    const readOnly = !message.controller;
    enqueueWrite('', current, () => {
      if (readOnly && terminal) terminal.resize(hostCols, hostRows);
    }, scheduleFit);
    updateUI();
    if (gainedControl) {
      sentCols = 0;
      sentRows = 0;
      scheduleFit();
    }
  } else if (message.type === 'error') {
    showError(message.message);
  }
}

async function connect(): Promise<void> {
  if (!selectedId || !csrf) return;
  const id = selectedId;
  cancelConnection();
  // A fresh xterm prevents already queued parser work from reaching another session.
  resetTerminal();
  const current = connection;
  const currentEpoch = epoch;
  updateUI();
  connectionLabel.textContent = '正在连接';
  try {
    // Refresh CSRF and check expiration before every websocket attempt.
    const response = await fetch('/api/auth', { credentials: 'same-origin', cache: 'no-store' });
    if (current !== connection || currentEpoch !== epoch) return;
    if (response.status === 401) { showLogin('登录已过期，请重新登录。'); return; }
    if (!response.ok) throw new Error('身份验证服务暂不可用。');
    const auth = await response.json() as { csrf?: string };
    if (current !== connection || currentEpoch !== epoch) return;
    if (!auth.csrf) throw new Error('无法验证登录状态。');
    csrf = auth.csrf;
    const stateResponse = await fetch(`/api/sessions/${encodeURIComponent(id)}`, { credentials: 'same-origin', cache: 'no-store' });
    if (current !== connection || currentEpoch !== epoch) return;
    if (stateResponse.status === 401) { showLogin('登录已过期，请重新登录。'); return; }
    if (stateResponse.status === 404) {
      applyCatalog(sessions.filter(item => item.id !== id));
      void refreshCatalog();
      return;
    }
    if (!stateResponse.ok) throw new Error('无法读取会话状态。');
    const state = await stateResponse.json() as SessionStatus;
    if (current !== connection || currentEpoch !== epoch) return;
    if (state.id !== id) throw new Error('会话标识不匹配。');
    updateSession(state);
    const url = new URL('/terminal', location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('session', id);
    const ws = new WebSocket(url);
    socket = ws;
    ws.addEventListener('open', () => {
      if (current !== connection) { ws.close(); return; }
      online = true;
      showError(session?.error || '');
      updateUI();
    });
    ws.addEventListener('message', (event: MessageEvent) => {
      if (current !== connection) return;
      try { receive(JSON.parse(String(event.data)) as ServerMessage, current); }
      catch { showError('收到无法读取的终端消息。'); }
    });
    ws.addEventListener('close', (event) => {
      if (current !== connection) return;
      if (event.code === 4001) { showLogin('登录已过期，请重新登录。'); return; }
      cancelConnection();
      clearWrites();
      updateUI();
      reconnectLater(connection);
    });
    ws.addEventListener('error', () => {
      if (current === connection) showError('终端连接失败，正在重连。');
    });
  } catch (error) {
    if (current !== connection || currentEpoch !== epoch) return;
    showError(error instanceof Error ? error.message : '连接失败。');
    reconnectLater(current);
  }
}

function reconnectLater(current: number): void {
  if (current !== connection || !selectedId || !csrf) return;
  const delay = Math.min(1000 * 2 ** Math.min(retryCount++, 5), 30000);
  clearTimeout(retryTimer);
  connectionLabel.textContent = `已断开 · ${Math.ceil(delay / 1000)} 秒后重连`;
  retryTimer = window.setTimeout(() => { if (current === connection) void connect(); }, delay);
}

async function mutation(path: string): Promise<Response | null> {
  const current = epoch;
  const response = await fetch(path, {
    method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': csrf },
  });
  if (current !== epoch) return null;
  if (response.status === 401) { showLogin('登录已过期，请重新登录。'); return null; }
  if (!response.ok) {
    const result = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(result.error || `请求失败（${response.status}）。`);
  }
  return response;
}

async function changeSession(action: 'start' | 'stop', id: string | null = selectedId): Promise<void> {
  if (busy || !id) return;
  const name = sessions.find(item => item.id === id)?.name || id;
  const revision = catalogRevision;
  busy = true;
  const current = epoch;
  showError('');
  updateUI();
  try {
    const response = await mutation(`/api/sessions/${encodeURIComponent(id)}/${action}`);
    if (!response || current !== epoch) return;
    const result = await response.json() as SessionStatus;
    if (current !== epoch) return;
    if (revision === catalogRevision) updateSession(result);
    else void refreshCatalog();
    if (action === 'start' && id === selectedId && !online) void connect();
    stopDialog.close();
    updateUI();
  } catch (error) {
    if (current !== epoch) return;
    stopDialog.close();
    showError(`${name}：${error instanceof Error ? error.message : '操作失败，请重试。'}`);
  } finally {
    if (current === epoch) { busy = false; updateUI(); }
  }
}

async function logout(): Promise<void> {
  if (busy) return;
  busy = true;
  const current = epoch;
  updateUI();
  try {
    const response = await mutation('/api/logout');
    if (response && current === epoch) showLogin();
  } catch (error) {
    if (current === epoch) showError(error instanceof Error ? error.message : '退出失败，登录仍然有效。');
  } finally {
    if (current === epoch) { busy = false; updateUI(); }
  }
}

async function copyResume(target: HTMLButtonElement): Promise<void> {
  const current = epoch;
  const id = selectedId;
  if (!id || session?.state !== 'stopped' || !session.sessionFile) return;
  try {
    await navigator.clipboard.writeText(nativeCommand.textContent || '');
    if (current !== epoch || id !== selectedId) return;
    target.replaceChildren(icon('check'));
    target.title = '已复制';
    target.setAttribute('aria-label', '已复制');
    renderIcons();
    clearTimeout(copyTimer);
    copyTimer = window.setTimeout(() => {
      if (current !== epoch || id !== selectedId) return;
      target.replaceChildren(icon('copy'));
      target.title = '复制恢复命令';
      target.setAttribute('aria-label', '复制恢复命令');
      renderIcons();
    }, 1500);
  } catch {
    if (current === epoch && id === selectedId) showError('无法访问剪贴板，请选择并复制恢复命令。');
  }
}

async function bootstrap(): Promise<void> {
  root.append(element('div', 'loading', '正在验证登录状态…'));
  const current = epoch;
  try {
    const response = await fetch('/api/auth', { credentials: 'same-origin', cache: 'no-store' });
    if (current !== epoch) return;
    if (response.status === 401) { showLogin('', true); return; }
    if (!response.ok) throw new Error('无法连接服务器，请稍后重试。');
    const auth = await response.json() as { csrf?: string };
    if (current !== epoch) return;
    if (!auth.csrf) throw new Error('无法验证登录状态。');
    csrf = auth.csrf;
    showTerminal();
    startCatalog();
  } catch {
    if (current === epoch) showLogin('无法连接服务器，请稍后重试。', true);
  }
}

void bootstrap();
