'use strict';
const { join, dirname } = require('node:path');
const { spawn } = require('node:child_process');
const home = dirname(process.execPath);
const args = process.argv.slice(2);
const installing = args[0] === 'install';
const env = { ...process.env };
// Do not allow inherited Node flags to inject code into the packaged host.
delete env.NODE_OPTIONS;
delete env.NODE_PATH;
const child = installing
  ? spawn(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(home, 'install.ps1')], { stdio: 'inherit', env, windowsHide: false })
  : spawn(join(home, 'runtime/node.exe'), [join(home, 'app/cli.mjs'), ...args], { stdio: ['inherit', 'inherit', 'inherit', 'ipc'], env, windowsHide: false });
// Both processes share the console and receive Ctrl+C. Let the host finish its own teardown.
const shutdown = () => { if (child.connected) child.send({ type: 'shutdown' }); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
child.once('error', error => { console.error(`Cannot start ompw: ${error.message}`); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
