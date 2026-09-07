import { mkdir, cp, readFile, writeFile, rm, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { inject } from 'postject';

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('This packaging target requires Windows x64.');
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(root, 'dist', 'ompw-win32-x64');
const stage = join(root, 'dist', 'build');
await rm(output, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
await mkdir(join(output, 'app'), { recursive: true });
await mkdir(join(output, 'runtime'), { recursive: true });
await build({ entryPoints: [join(root, 'src/web/main.ts')], bundle: true, format: 'esm', target: 'es2022', outdir: join(output, 'public'), entryNames: 'app', minify: true });
await copyFile(join(root, 'public/index.html'), join(output, 'public/index.html'));
await build({ entryPoints: [join(root, 'src/cli.ts')], bundle: true, platform: 'node', format: 'esm', target: 'node24', outfile: join(output, 'app/cli.mjs'), external: ['node-pty'], banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' } });
await copyFile(join(root, 'src/omp-extension.ts'), join(output, 'app/omp-extension.ts'));
await copyFile(join(root, 'LICENSE'), join(output, 'LICENSE'));
await copyFile(join(root, 'README.md'), join(output, 'README.md'));
for (const item of ['src', 'scripts', 'test', 'public/index.html', 'package.json', 'package-lock.json', 'tsconfig.json', 'LICENSE', 'README.md', '.github']) {
  await cp(join(root,item),join(output,'source',item),{recursive:true});
}
const native = join(output, 'app/node_modules/node-pty');
await mkdir(native, { recursive: true });
for (const item of ['package.json', 'LICENSE', 'lib', 'prebuilds/win32-x64']) {
  await cp(join(root, 'node_modules/node-pty', item), join(native, item), { recursive: true, filter: path => !/\.(?:pdb|map)$|\.test\.js$/.test(path) });
}
await copyFile(process.execPath, join(output, 'runtime/node.exe'));
await copyFile(join(root, 'scripts/install.ps1'), join(output, 'install.ps1'));
const bootstrap = join(stage, 'bootstrap.cjs');
await copyFile(join(dirname(process.execPath), 'LICENSE'), join(output, 'runtime/LICENSE'));
await copyFile(join(root, 'scripts/bootstrap.cjs'), bootstrap);
const config = join(stage, 'sea.json');
const blob = join(stage, 'sea.blob');
await writeFile(config, JSON.stringify({ main: bootstrap, output: blob, disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false, execArgvExtension: 'none' }));
execFileSync(process.execPath, ['--experimental-sea-config', config], { stdio: 'inherit' });
const executable = join(output, 'ompw.exe');
await copyFile(process.execPath, executable);
await inject(executable, 'NODE_SEA_BLOB', await readFile(blob), { sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2' });
// Preserve upstream license notices for the bundled runtime and JavaScript dependencies.
const notices = ['Node.js license and third-party notices are included in runtime/LICENSE.'];
const dependencies = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8')).packages;
for (const [path, metadata] of Object.entries(dependencies)) {
  if (!path || metadata.dev) continue;
  for (const file of ['LICENSE', 'LICENSE.md', 'LICENSE-MIT', 'LICENSE.txt', 'license', 'license.md']) {
    try { notices.push(`\n===== ${path} =====\n${await readFile(join(root, path, file), 'utf8')}`); break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
await writeFile(join(output, 'THIRD-PARTY-NOTICES.txt'), notices.join('\n'));
const archive = `${output}.zip`;
execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', '$ErrorActionPreference = \"Stop\"; Compress-Archive -LiteralPath $env:OMPW_PACKAGE_DIR -DestinationPath $env:OMPW_PACKAGE_ZIP -Force'], { stdio: 'inherit', env: { ...process.env, OMPW_PACKAGE_DIR: output, OMPW_PACKAGE_ZIP: archive } });
await rm(stage, { recursive: true });
console.log(`Built ${executable}\nKeep the entire ompw-win32-x64 directory together. Run ompw.exe install to install the command.`);
