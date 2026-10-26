// Builds the Windows app folder and zip:
//   dist/windows/NIO-Runner/
//     nio-runner.exe              console program (run, check, init)
//     nio-runner-background.exe   same program without a console window, used by the auto-start task
//     nio-runner.example.json, install.ps1, uninstall.ps1, README.txt
//   dist/NIO-Runner-win-x64-<version>.zip
//
// Uses Node's Single Executable Application support: the bundled runner is injected into the
// official node.exe for the same Node version that builds the blob. Runs on any OS.
//
//   node scripts/build-windows.mjs [--node-exe path\to\node.exe] [--target linux]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const args = process.argv.slice(2);
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const target = opt('--target') ?? 'win';
const work = path.join(root, 'build');
const out = path.join(root, 'dist', target === 'win' ? 'windows' : target, 'NIO-Runner');
const SENTINEL = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

fs.rmSync(work, { recursive: true, force: true });
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });
fs.mkdirSync(out, { recursive: true });

// 1. Bundle the runner into one CommonJS file (SEA requires a single CJS entry).
await build({
  entryPoints: [path.join(root, 'src', 'main.ts')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: path.join(work, 'nio-runner.cjs'),
  legalComments: 'none',
  logLevel: 'warning',
});

// 2. Create the SEA blob with this Node (must match the node.exe it is injected into).
const seaConfig = path.join(work, 'sea-config.json');
fs.writeFileSync(
  seaConfig,
  JSON.stringify({ main: path.join(work, 'nio-runner.cjs'), output: path.join(work, 'sea-prep.blob'), disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false }),
);
execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' });

// 3. Get the matching official Node binary.
async function nodeBinary() {
  if (target !== 'win') return process.execPath;
  const given = opt('--node-exe');
  if (given) return given;
  const cached = path.join(root, '.cache', `node-${process.version}-win-x64.exe`);
  if (!fs.existsSync(cached)) {
    const url = `https://nodejs.org/dist/${process.version}/win-x64/node.exe`;
    console.log(`Downloading ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);
    fs.mkdirSync(path.dirname(cached), { recursive: true });
    fs.writeFileSync(cached, Buffer.from(await res.arrayBuffer()));
  }
  return cached;
}

const exeName = target === 'win' ? 'nio-runner.exe' : 'nio-runner';
const exe = path.join(out, exeName);
fs.copyFileSync(await nodeBinary(), exe);
fs.chmodSync(exe, 0o755);

// 4. Inject the blob.
const postject = path.join(root, '..', 'node_modules', 'postject', 'dist', 'cli.js');
execFileSync(process.execPath, [postject, exe, 'NODE_SEA_BLOB', path.join(work, 'sea-prep.blob'), '--sentinel-fuse', SENTINEL, '--overwrite'], { stdio: 'inherit' });

/** Sets the PE optional-header Subsystem field (2 = Windows GUI, 3 = console). */
export function setPeSubsystem(file, subsystem) {
  const buf = fs.readFileSync(file);
  const pe = buf.readUInt32LE(0x3c);
  if (buf.toString('latin1', pe, pe + 4) !== 'PE\0\0') throw new Error(`${file} is not a PE file`);
  const optional = pe + 24;
  const magic = buf.readUInt16LE(optional);
  if (magic !== 0x20b && magic !== 0x10b) throw new Error('Unexpected PE optional header');
  buf.writeUInt16LE(subsystem, optional + 68);
  fs.writeFileSync(file, buf);
}

if (target === 'win') {
  // 5. Windowless copy for the logon task: GUI subsystem means Windows never opens a console.
  const bg = path.join(out, 'nio-runner-background.exe');
  fs.copyFileSync(exe, bg);
  setPeSubsystem(bg, 2);

  // 6. Support files.
  for (const f of ['install.ps1', 'uninstall.ps1', 'README.txt']) fs.copyFileSync(path.join(root, 'windows', f), path.join(out, f));
  const { EXAMPLE_CONFIG } = await import(pathToImport(path.join(root, 'dist', 'config.js')));
  fs.writeFileSync(path.join(out, 'nio-runner.example.json'), JSON.stringify(EXAMPLE_CONFIG, null, 2) + '\r\n');

  // 7. Zip.
  const zip = path.join(root, 'dist', `NIO-Runner-win-x64-${pkg.version}.zip`);
  fs.rmSync(zip, { force: true });
  if (process.platform === 'win32') {
    execFileSync('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${out}' -DestinationPath '${zip}'`], { stdio: 'inherit' });
  } else {
    execFileSync('zip', ['-qr', zip, 'NIO-Runner'], { cwd: path.dirname(out) });
  }
  console.log(`Built ${out}\nZipped ${zip}`);
} else {
  console.log(`Built ${exe}`);
}

function pathToImport(p) {
  return new URL(`file://${p.replace(/\\/g, '/')}`).href;
}
