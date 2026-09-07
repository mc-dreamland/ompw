import { createServer, request } from 'node:http';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { atomicJson } from './config.ts';

export interface DaemonAddress { version: 1; pid: number; port: number; token: string; origin: string }
export async function daemonAddress(dataDir: string): Promise<DaemonAddress | undefined> {
  let value: DaemonAddress;
  try { value = JSON.parse(await readFile(join(dataDir, 'daemon.json'), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  if (value.version !== 1 || !Number.isInteger(value.pid) || value.pid <= 0 || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 || !/^[a-f0-9]{64}$/.test(value.token) || typeof value.origin !== 'string') throw new Error('Invalid daemon.json; inspect private state before proceeding.');
  try { process.kill(value.pid, 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') throw new Error('Previous daemon exited unexpectedly. Inspect server.lock and hosted OMP processes before recovery.'); throw error; }
  return value;
}
export async function control(address: DaemonAddress, command: object): Promise<any> {
  return new Promise((accept, reject) => {
    const body = JSON.stringify(command);
    const req = request({ hostname: '127.0.0.1', port: address.port, path: '/control', method: 'POST', headers: { Authorization: `Bearer ${address.token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 120000 }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; if (text.length > 1024 * 1024) res.destroy(new Error('Control response too large.')); });
      res.on('error', reject);
      res.on('end', () => { try { const value = JSON.parse(text); if (res.statusCode !== 200) throw new Error(value.error ?? 'Daemon command failed.'); accept(value); } catch (error) { reject(error); } });
    });
    req.on('timeout', () => req.destroy(new Error('Daemon command timed out.')));
    req.on('error', reject); req.end(body);
  });
}
export async function controlServer(dataDir: string, origin: string, execute: (command: any) => Promise<unknown>, shutdown: () => Promise<void>) {
  const token = randomBytes(32).toString('hex');
  let closing = false;
  const operations = new Set<Promise<unknown>>();
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store');
    try {
      const bearer = req.headers.authorization;
      if (req.headers.origin || req.headers['sec-fetch-site'] || req.method !== 'POST' || req.url !== '/control' || typeof bearer !== 'string' || !/^Bearer [a-f0-9]{64}$/.test(bearer) || !timingSafeEqual(Buffer.from(bearer), Buffer.from(`Bearer ${token}`))) { res.writeHead(403); res.end('{"error":"Forbidden"}'); return; }
      if (closing) throw new Error('Daemon is stopping.');
      if (req.headers['content-type'] !== 'application/json') throw new Error('JSON required.');
      req.setEncoding('utf8');
      let body = ''; let bytes = 0;
      for await (const chunk of req) {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 8192) throw new Error('Control request too large.');
        body += chunk;
      }
      const command = JSON.parse(body);
      if (!command || typeof command !== 'object' || Array.isArray(command)) throw new Error('Invalid command.');
      if (closing) throw new Error('Daemon is stopping.');
      if (command.type === 'shutdown') {
        closing = true;
        await Promise.allSettled([...operations]);
        try { await shutdown(); } catch (error) { closing = false; throw error; }
        res.once('finish', () => { server.close(); });
        res.end(JSON.stringify({ stopped: true }));
        return;
      }
      const operation = execute(command); operations.add(operation);
      try { res.end(JSON.stringify(await operation)); } finally { operations.delete(operation); }
    } catch (error) { if (!res.destroyed && !res.writableEnded) { res.writeHead(409); res.end(JSON.stringify({error:(error as Error).message})); } }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.maxConnections = 32;
  await new Promise<void>((accept,reject) => { server.once('error',reject); server.listen(0,'127.0.0.1',()=>{server.off('error',reject);accept();}); });
  const address: DaemonAddress = {version:1,pid:process.pid,port:(server.address() as {port:number}).port,token,origin};
  try { await atomicJson(join(dataDir,'daemon.json'),address); }
  catch (error) { server.close(); throw error; }
  return {
    async pause() { closing=true; await Promise.allSettled([...operations]); },
    resume() { closing=false; },
    async close() { closing=true; await Promise.allSettled([...operations]); server.close(); await unlink(join(dataDir,'daemon.json')); },
  };
}
