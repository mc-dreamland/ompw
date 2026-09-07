import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
import { WebSocket } from 'ws';
import { Secret, TOTP } from 'otpauth';
import { Authentication } from '../src/auth.ts';
import { derive } from '../src/config.ts';
import { SessionRegistry } from '../src/registry.ts';
import { serve } from '../src/server.ts';

test('HTTP and websocket require authentication, exact origin, and CSRF; logout closes established sockets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ompw-http-'));
  const password = randomBytes(24).toString('hex'); const salt = randomBytes(16).toString('hex'); const secret = new Secret();
  const origin = 'http://127.0.0.1';
  const auth = new Authentication({ version: 1, salt, hash: (await derive(password, salt)).toString('hex'), secret: secret.base32, lastCounter: -1 }, directory);
  const id = '11111111-1111-4111-8111-111111111111';
  const otherId = '22222222-2222-4222-8222-222222222222';
  await writeFile(join(directory,'sessions.json'),JSON.stringify({version:1,sessions:[id,otherId].map((id,index)=>({id,name:`test-${index}`,createdAt:new Date().toISOString(),cwd:directory,sessionFile:null,sessionId:null,stateDir:`hosts/${id}`}))}));
  const registry = new SessionRegistry({ dataDir: directory, ompPath: 'omp' });
  await registry.initialize();
  const app = await serve({ host: '127.0.0.1', port: 0, origin }, auth, registry);
  const port = (app.address as { port: number }).port;
  const http = (path: string, method = 'GET', headers: Record<string, string> = {}, body?: string) => new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; body: string }>((accept, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method, headers: { Host: '127.0.0.1', ...headers } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; }); res.on('end', () => accept({ status: res.statusCode!, headers: res.headers, body: text }));
    }); req.on('error', reject); req.end(body);
  });
  const rejectSocket = (headers: Record<string, string>, expected: number) => new Promise<void>((accept, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/terminal?session=${id}`, { headers: { Host: '127.0.0.1', ...headers } });
    ws.on('open', () => { ws.terminate(); reject(new Error('Unauthorized upgrade succeeded')); });
    ws.on('error', () => {});
    ws.on('unexpected-response', (_req, res) => { res.resume(); ws.terminate(); try { assert.equal(res.statusCode, expected); accept(); } catch (e) { reject(e); } });
  });
  try {
    assert.equal((await http('/api/sessions')).status, 401);
    assert.equal((await http('/', 'GET', { Host: 'attacker.invalid' })).status, 403);
    assert.equal((await http('/api/login', 'POST', { Origin: 'http://attacker.invalid' })).status, 403);
    assert.equal((await http('/api/login', 'POST')).status, 403);
    assert.equal((await http('/api/login', 'POST', { Origin: origin, 'Content-Type': 'text/plain' }, '{}')).status, 415);
    const logged = await http('/api/login', 'POST', { Origin: origin, 'Content-Type': 'application/json' }, JSON.stringify({ password, code: new TOTP({ secret }).generate() }));
    assert.equal(logged.status, 200);
    const setCookie = logged.headers['set-cookie']![0];
    assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /SameSite=Strict/);
    const cookie = setCookie.split(';')[0]; const csrf = JSON.parse(logged.body).csrf;
    assert.equal((await http('/api/sessions', 'GET', { Cookie: cookie })).status, 200);
    assert.equal((await http('/api/session', 'GET', { Cookie: cookie })).status, 404);
    assert.equal((await http('/api/sessions/33333333-3333-4333-8333-333333333333', 'GET', { Cookie: cookie })).status, 404);
    assert.equal((await http('/api/logout', 'POST', { Cookie: cookie, Origin: origin })).status, 403);
    assert.equal((await http('/api/logout', 'POST', { Cookie: cookie, Origin: origin, 'X-CSRF-Token': 'bad' })).status, 403);
    await rejectSocket({ Origin: origin }, 401);
    await rejectSocket({ Origin: 'http://attacker.invalid', Cookie: cookie }, 403);
    await rejectSocket({ Cookie: cookie }, 403);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/terminal?session=${id}`, { headers: { Host: '127.0.0.1', Origin: origin, Cookie: cookie } });
    await new Promise<void>((accept, reject) => { ws.once('message', data => { try { assert.equal(JSON.parse(data.toString()).type, 'snapshot'); accept(); } catch (e) { reject(e); } }); ws.once('error', reject); });
    const connectTarget = async (target: string) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/terminal?session=${target}`, {headers:{Host:'127.0.0.1',Origin:origin,Cookie:cookie}});
      const {promise,resolve,reject}=Promise.withResolvers<any>();
      socket.on('message',data=>{const message=JSON.parse(data.toString());if(message.type==='snapshot')resolve(message);});
      socket.once('error',reject);
      return {socket,snapshot:await promise};
    };
    const viewer = await connectTarget(id);
    const independent = await connectTarget(otherId);
    assert.equal(viewer.snapshot.controller,false);
    assert.equal(independent.snapshot.controller,true);
    const originalSize = registry.describe(id)!.cols;
    const resized=Promise.withResolvers<void>();
    independent.socket.on('message',data=>{const message=JSON.parse(data.toString());if(message.type==='status' && message.session.cols===73)resized.resolve();});
    independent.socket.send(JSON.stringify({type:'resize',cols:73,rows:19}));
    await resized.promise;
    assert.equal(registry.describe(id)!.cols,originalSize);
    assert.equal(registry.describe(otherId)!.cols,73);
    viewer.socket.close(); independent.socket.close();
    const closed = new Promise<number>(accept => ws.once('close', code => accept(code)));
    assert.equal((await http('/api/logout', 'POST', { Cookie: cookie, Origin: origin, 'X-CSRF-Token': csrf })).status, 204);
    assert.equal(await closed, 4001);
    assert.equal((await http('/api/sessions', 'GET', { Cookie: cookie })).status, 401);
    await rejectSocket({ Origin: origin, Cookie: cookie }, 401);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
