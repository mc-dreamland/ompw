import { createServer as httpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { Authentication, AuthError, type LoginSession } from './auth.ts';
import type { HostedSession } from './session.ts';
import type { SessionRegistry } from './registry.ts';

export interface ServerOptions { host: string; port: number; origin: string; cert?: string; key?: string }
const loopback = (host: string) => ['127.0.0.1', '::1', 'localhost', '[::1]'].includes(host);
const sessionIdPattern = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const selectedPage = new RegExp(`^/\\?session=${sessionIdPattern}$`);
const sessionRoute = new RegExp(`^/api/sessions/(${sessionIdPattern})(?:/(start|stop))?$`);
const terminalRoute = new RegExp(`^/terminal\\?session=(${sessionIdPattern})$`);
class HttpError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }
function cookie(request: IncomingMessage, name: string): string | undefined {
  const values = (request.headers.cookie ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${name}=`));
  return values.length === 1 ? values[0].slice(name.length + 1) : undefined;
}
async function jsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new HttpError(415, 'JSON required.');
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 4096) throw new HttpError(413, 'Request too large.');
    chunks.push(chunk);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch { throw new HttpError(400, 'Invalid JSON.'); }
}
export async function serve(options: ServerOptions, auth: Authentication, registry: SessionRegistry) {
  const origin = new URL(options.origin);
  if (origin.origin !== options.origin || origin.username || origin.password || !['http:', 'https:'].includes(origin.protocol)) throw new Error('--origin must be an exact http(s) origin without trailing slash.');
  if (!!options.cert !== !!options.key) throw new Error('--cert and --key must be provided together.');
  const tls = options.cert && options.key ? { cert: await readFile(options.cert), key: await readFile(options.key), minVersion: 'TLSv1.2' as const } : undefined;
  if (!tls && !loopback(options.host)) throw new Error('Non-loopback listeners require --cert and --key.');
  if (tls && origin.protocol !== 'https:') throw new Error('TLS requires an https origin.');
  if (origin.protocol === 'http:' && (!loopback(origin.hostname) || !loopback(options.host))) throw new Error('HTTP is allowed only on loopback.');
  const secure = origin.protocol === 'https:';
  const cookieName = secure ? '__Host-ompw' : 'ompw-local';
  const cookieValue = (value: string, age: number) => `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure ? '; Secure' : ''}`;
  const assets = new Map<string, { type: string; body: Buffer }>();
  for (const [path, file, type] of [['/', 'index.html', 'text/html; charset=utf-8'], ['/app.js', 'app.js', 'text/javascript; charset=utf-8'], ['/app.css', 'app.css', 'text/css; charset=utf-8']]) {
    assets.set(path, { type, body: await readFile(fileURLToPath(new URL(`../public/${file}`, import.meta.url))) });
  }
  assets.set('/LICENSE', { type: 'text/plain; charset=utf-8', body: await readFile(fileURLToPath(new URL('../LICENSE', import.meta.url))) });
  const sockets = new Map<WebSocket, {
    session: LoginSession; id: string; hosted: HostedSession; alive: boolean; ready: boolean;
    listener: (data: string) => void; window: number; messages: number; inputBytes: number;
  }>();
  const controllers = new Map<string, WebSocket>();
  const operations = new Set<Promise<unknown>>();
  let closing = false;
  let closeOperation: Promise<void> | undefined;
  const send = (socket: WebSocket, value: unknown): boolean => {
    const client = sockets.get(socket);
    if (!client || socket.readyState !== WebSocket.OPEN) return false;
    if (!auth.validate(client.session)) { socket.close(4001, 'Authentication expired'); return false; }
    if (socket.bufferedAmount > 1024 * 1024) { socket.close(1013, 'Slow connection'); return false; }
    socket.send(JSON.stringify(value));
    return true;
  };
  const controllerFor = (id: string): WebSocket | undefined => {
    const socket = controllers.get(id);
    if (!socket) return undefined;
    const client = sockets.get(socket);
    if (client && socket.readyState === WebSocket.OPEN && auth.validate(client.session)) return socket;
    controllers.delete(id);
    if (client && !auth.validate(client.session)) socket.close(4001, 'Authentication expired');
    return undefined;
  };
  const publishStatus = (id: string) => {
    const state = registry.describe(id);
    if (!state) return;
    const controller = controllerFor(id);
    for (const [socket, client] of sockets) {
      if (client.id === id) send(socket, { type: 'status', session: state, controller: controller === socket });
    }
  };
  const publish = () => {
    const sessions = registry.list();
    const states = new Map(sessions.map(session => [session.id, session]));
    for (const [socket, client] of sockets) {
      if (!send(socket, { type: 'sessions', sessions })) continue;
      const state = states.get(client.id);
      if (!state || registry.get(client.id) !== client.hosted) { socket.close(1008, 'Session unavailable'); continue; }
      send(socket, { type: 'status', session: state, controller: controllerFor(client.id) === socket });
    }
  };
  const revokeSockets = (session: LoginSession) => {
    for (const [socket, client] of sockets) if (client.session === session) socket.close(4001, 'Authentication expired');
  };
  const disconnect = (socket: WebSocket) => {
    const client = sockets.get(socket);
    if (!client) return;
    client.hosted.off('data', client.listener);
    sockets.delete(socket);
    if (controllers.get(client.id) === socket) controllers.delete(client.id);
    if (!closing) publishStatus(client.id);
  };
  const headers = (response: ServerResponse) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    response.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self' ${origin.protocol === 'https:' ? 'wss:' : 'ws:'}//${origin.host}; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'`);
    if (secure) response.setHeader('Strict-Transport-Security', 'max-age=31536000');
  };
  const checkHost = (request: IncomingMessage) => {
    if (request.headers.host !== origin.host) throw new HttpError(403, 'Host denied.');
    if (request.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Cross-site request denied.');
  };
  const checkOrigin = (request: IncomingMessage) => { if (request.headers.origin !== origin.origin) throw new HttpError(403, 'Origin denied.'); };
  const respond = (response: ServerResponse, status: number, value?: unknown) => {
    response.statusCode = status;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(value === undefined ? undefined : JSON.stringify(value));
  };
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    headers(response);
    try {
      checkHost(request);
      if (closing) throw new HttpError(503, 'Server stopping.');
      const path = request.url ?? '';
      const assetPath = selectedPage.test(path) ? '/' : path;
      if (request.method === 'GET' && assets.has(assetPath)) {
        const asset = assets.get(assetPath)!;
        response.setHeader('Content-Type', asset.type); response.end(asset.body); return;
      }
      if (request.method === 'POST') checkOrigin(request);
      if (path === '/api/login' && request.method === 'POST') {
        const body = await jsonBody(request);
        const result = await auth.login(body.password, body.code, request.socket.remoteAddress ?? 'unknown');
        // Reauthentication rotates credentials and closes any socket using the old cookie.
        const previous = auth.authenticate(cookie(request, cookieName));
        if (previous) { auth.revoke(previous); revokeSockets(previous); }
        response.setHeader('Set-Cookie', cookieValue(result.token, 43200));
        respond(response, 200, { csrf: result.session.csrf }); return;
      }
      const session = auth.authenticate(cookie(request, cookieName));
      if (!session) throw new HttpError(401, 'Authentication required.');
      if (request.method === 'POST' && !auth.csrf(session, request.headers['x-csrf-token'])) throw new HttpError(403, 'CSRF verification failed.');
      if (path === '/api/auth' && request.method === 'GET') { respond(response, 200, { csrf: session.csrf }); return; }
      if (path === '/api/sessions' && request.method === 'GET') { respond(response, 200, { sessions: registry.list() }); return; }
      if (path === '/api/logout' && request.method === 'POST') {
        auth.revoke(session); revokeSockets(session);
        response.setHeader('Set-Cookie', cookieValue('', 0)); respond(response, 204); return;
      }
      const target = sessionRoute.exec(path);
      if (target && ((request.method === 'GET' && !target[2]) || (request.method === 'POST' && target[2]))) {
        const id = target[1];
        const state = registry.describe(id);
        if (!state) throw new HttpError(404, 'Session not found.');
        if (request.method === 'GET') { respond(response, 200, state); return; }
        if (!auth.validate(session, true)) throw new HttpError(401, 'Authentication required.');
        if (closing) throw new HttpError(503, 'Server stopping.');
        try {
          const operation = target[2] === 'stop' ? registry.stop(id) : registry.start(id);
          operations.add(operation);
          try { await operation; } finally { operations.delete(operation); }
        } catch (error) { throw new HttpError(409, (error as Error).message); }
        if (!auth.validate(session)) throw new HttpError(401, 'Authentication required.');
        respond(response, 200, registry.describe(id)); return;
      }
      throw new HttpError(404, 'Not found.');
    } catch (error) {
      if (response.destroyed || response.writableEnded) return;
      const known = error instanceof HttpError || error instanceof AuthError;
      if (known && error.status === 429) response.setHeader('Retry-After', '300');
      if (!known) console.error('Request failed:', (error as Error).name);
      if (error instanceof AuthError && error.retryAfter) response.setHeader('Retry-After', String(error.retryAfter));
      respond(response, known ? error.status : 500, {
        error: known ? error.message : 'Internal server error.',
        ...(error instanceof AuthError ? { code: error.code, retryAfter: error.retryAfter } : {}),
      });
    }
  };
  const server = tls ? httpsServer(tls, (req, res) => { void handle(req, res); }) : httpServer((req, res) => { void handle(req, res); });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 32;
  server.maxConnections = 128;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65536, perMessageDeflate: false });
  server.on('upgrade', (request, socket, head) => {
    try {
      checkHost(request); checkOrigin(request);
      const target = terminalRoute.exec(request.url ?? '');
      if (closing || request.method !== 'GET' || !target) throw new HttpError(404, 'Not found.');
      const session = auth.authenticate(cookie(request, cookieName));
      if (!session) throw new HttpError(401, 'Authentication required.');
      const id = target[1];
      const hosted = registry.get(id);
      if (!hosted) throw new HttpError(404, 'Session not found.');
      let loginConnections = 0; let targetConnections = 0;
      for (const client of sockets.values()) {
        if (client.session === session) loginConnections++;
        if (client.id === id) targetConnections++;
      }
      if (sockets.size >= 64 || loginConnections >= 8 || targetConnections >= 8) throw new HttpError(429, 'Connection limit.');
      wss.handleUpgrade(request, socket, head, ws => connect(ws, session, id, hosted));
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 400;
      socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    }
  });
  function connect(socket: WebSocket, session: LoginSession, id: string, hosted: HostedSession) {
    const client = { session, id, hosted, alive: true, ready: false, listener: (_data: string) => {}, window: Date.now(), messages: 0, inputBytes: 0 };
    sockets.set(socket, client);
    if (!controllerFor(id)) controllers.set(id, socket);
    client.listener = data => {
      if (!auth.validate(session)) { socket.close(4001, 'Authentication expired'); return; }
      if (client.ready) send(socket, { type: 'output', id, data });
    };
    hosted.on('data', client.listener);
    // The host parser barrier includes all prior emissions and yields before parsing future output.
    const snapshot = hosted.snapshot();
    void snapshot.then(data => {
      if (!sockets.has(socket) || closing) return;
      const state = registry.describe(id);
      if (!state || registry.get(id) !== hosted) { socket.close(1008, 'Session unavailable'); return; }
      if (!send(socket, { type: 'snapshot', id, data, cols: state.cols, rows: state.rows, controller: controllerFor(id) === socket })) return;
      client.ready = true;
      publishStatus(id);
    }).catch(() => socket.close(1011, 'Snapshot failed'));
    socket.on('pong', () => { client.alive = true; });
    socket.on('error', () => { disconnect(socket); socket.terminate(); });
    socket.on('close', () => disconnect(socket));
    socket.on('message', (raw, binary) => {
      if (closing || !sockets.has(socket)) return;
      if (!auth.validate(session)) { socket.close(4001, 'Authentication expired'); return; }
      if (binary || !client.ready) { socket.close(1008, 'Invalid message'); return; }
      if (Date.now() - client.window > 1000) { client.window = Date.now(); client.messages = 0; client.inputBytes = 0; }
      const payload = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      client.messages++; client.inputBytes += payload.length;
      if (client.messages > 120 || client.inputBytes > 262144) { socket.close(1008, 'Input limit'); return; }
      try {
        const value = JSON.parse(payload.toString());
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
        if (value.type === 'claim') {
          const controller = controllerFor(id);
          if (!controller) controllers.set(id, socket);
          else if (controller !== socket) send(socket, { type: 'error', message: 'Terminal is controlled by another connection.' });
          auth.validate(session, true); publishStatus(id); return;
        }
        if (value.type === 'release') { if (controllers.get(id) === socket) controllers.delete(id); publishStatus(id); return; }
        if (controllerFor(id) !== socket) { send(socket, { type: 'error', message: 'Read-only connection.' }); return; }
        if (value.type === 'input' && typeof value.data === 'string' && Buffer.byteLength(value.data) <= 32768) {
          hosted.write(value.data); auth.validate(session, true); return;
        }
        if (value.type === 'resize' && Number.isInteger(value.cols) && Number.isInteger(value.rows) && value.cols >= 20 && value.cols <= 300 && value.rows >= 5 && value.rows <= 120) {
          hosted.resize(value.cols, value.rows); return;
        }
        throw new Error();
      } catch { send(socket, { type: 'error', message: 'Invalid terminal operation.' }); }
    });
  }
  registry.on('changed', publish);
  const timer = setInterval(() => {
    auth.prune();
    for (const [socket, client] of sockets) {
      if (socket.readyState !== WebSocket.OPEN) { disconnect(socket); socket.terminate(); continue; }
      if (!auth.validate(client.session)) { socket.close(4001, 'Authentication expired'); continue; }
      if (!client.alive) { disconnect(socket); socket.terminate(); continue; }
      client.alive = false; socket.ping();
    }
  }, 15_000);
  timer.unref();
  try {
    await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(options.port, options.host, () => { server.off('error', reject); accept(); }); });
  } catch (error) { clearInterval(timer); registry.off('changed', publish); wss.close(); throw error; }
  return {
    address: server.address(),
    close(): Promise<void> {
      if (closeOperation) return closeOperation;
      closing = true;
      closeOperation = (async () => {
        await Promise.allSettled([...operations]);
        try { await registry.stopAll(); }
        catch (error) { closing = false; closeOperation = undefined; throw error; }
        clearInterval(timer); registry.off('changed', publish);
        for (const socket of sockets.keys()) { disconnect(socket); socket.terminate(); }
        controllers.clear();
        wss.close();
        await new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept()));
      })();
      return closeOperation;
    }
  };
}
