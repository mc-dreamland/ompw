import { join } from 'node:path';
import { readFile, unlink } from 'node:fs/promises';
import { acquireLock, atomicJson, loadCredentials } from './config.ts';
import { Authentication } from './auth.ts';
import { SessionRegistry } from './registry.ts';
import { serve, type ServerOptions } from './server.ts';
import { controlServer } from './control.ts';

export interface DaemonOptions extends ServerOptions { ompPath: string; autoPort?: boolean }
export async function runDaemon(dataDir: string): Promise<void> {
  const unlock = await acquireLock(dataDir);
  let controlListener: Awaited<ReturnType<typeof controlServer>> | undefined;
  let app: Awaited<ReturnType<typeof serve>> | undefined;
  try {
    const options: DaemonOptions = JSON.parse(await readFile(join(dataDir, 'service.json'), 'utf8'));
    const registry = new SessionRegistry({dataDir,ompPath:options.ompPath});
    await registry.initialize();
    const auth = new Authentication(await loadCredentials(dataDir),dataDir);
    for (;;) {
      try { app = await serve(options,auth,registry); break; }
      catch (error) {
        if (!options.autoPort || (error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || options.port >= 65535) throw error;
        options.port++;
        const origin = new URL(options.origin);
        origin.port = String(options.port);
        options.origin = origin.origin;
      }
    }
    await atomicJson(join(dataDir,'service.json'),options);
    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) throw new Error('Shutdown is already in progress.');
      shuttingDown = true;
      try {
        await controlListener?.pause();
        await app!.close();
        await unlink(join(dataDir,'daemon.json'));
        await unlock();
        setTimeout(()=>process.exit(0),250);
      } catch (error) { shuttingDown=false; controlListener?.resume(); throw error; }
    };
    controlListener = await controlServer(dataDir,options.origin,async command => {
      if (shuttingDown) throw new Error('Daemon is stopping.');
      if (command.type === 'status') return {origin:options.origin,sessions:registry.list()};
      if (command.type === 'register') {
        if (typeof command.cwd !== 'string' || (command.resume !== undefined && typeof command.resume !== 'string') || (command.newSession !== undefined && typeof command.newSession !== 'boolean')) throw new Error('Invalid registration.');
        return {origin:options.origin,session:await registry.register({cwd:command.cwd,resume:command.resume,newSession:command.newSession})};
      }
      throw new Error('Unknown local command.');
    },shutdown);
    process.on('SIGINT',()=>{void shutdown().catch(error=>console.error(error.message));});
    process.on('SIGTERM',()=>{void shutdown().catch(error=>console.error(error.message));});
    console.log(`ompw daemon ready at ${options.origin}`);
  } catch (error) {
    await controlListener?.close().catch(()=>{});
    if (app) await app.close();
    await unlock();
    throw error;
  }
}
