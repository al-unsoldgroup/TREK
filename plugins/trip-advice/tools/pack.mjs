#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const dir = resolve(process.argv[2] || '.');
const RUNTIME_FILES = [
  'trek-plugin.json',
  'server/index.js',
  'server/lib/advice-service.js',
  'server/lib/advice-store.js',
  'server/lib/protocol.js',
  'client/guest.html',
  'client/index.html',
  'client/advice.js',
  'client/advice-model.js',
  'client/advice-protocol.js',
  'client/advice-owner.js',
  'client/advice-guest-template.js',
  'client/advice-preview.js',
  'client/advice.css'
];

function assertNoSymlinks(root, relative = '') {
  if (relative === '' && lstatSync(root).isSymbolicLink()) throw new Error('symlink is not allowed in package source: .');
  for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
    const name = join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`symlink is not allowed in package source: ${name}`);
    if (entry.isDirectory() && !['.git', 'dist', 'node_modules'].includes(entry.name)) assertNoSymlinks(root, name);
  }
}

assertNoSymlinks(dir);
for (const file of RUNTIME_FILES) {
  if (!existsSync(join(dir, file))) throw new Error(`missing packaged file: ${file}`);
  if (!lstatSync(join(dir, file)).isFile()) throw new Error(`runtime file is not a regular file: ${file}`);
}
const manifest = JSON.parse(readFileSync(join(dir, 'trek-plugin.json'), 'utf8'));
if (!/^trip-advice$/.test(manifest.id)) throw new Error('manifest id must be trip-advice');
const outDir = resolve(dir, 'dist');
mkdirSync(outDir, { recursive: true });
const out = join(outDir, `${manifest.id}-${manifest.version}.zip`);
rmSync(out, { force: true });
const stage = mkdtempSync(join(tmpdir(), `${manifest.id}-`));
const clientAssets = new Set(RUNTIME_FILES.filter(file => file.startsWith('client/') && /\.(js|css)$/.test(file)).map(file => basename(file)));
for (const file of RUNTIME_FILES) {
  const target = join(stage, file);
  mkdirSync(resolve(target, '..'), { recursive: true });
  copyFileSync(join(dir, file), target);
  if (file.endsWith('.html')) {
    const html = readFileSync(target, 'utf8').replace(/\b(src|href)=(["'])([^"']+)\2/g, (match, attr, quote, value) =>
      clientAssets.has(value) ? `${attr}=${quote}${value}?v=${encodeURIComponent(manifest.version)}${quote}` : match);
    writeFileSync(target, html);
  }
}
execFileSync('python3', ['-c', `
from pathlib import Path
import sys
import zipfile

output, root = sys.argv[1:]
root_path = Path(root)
with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
    for path in sorted(root_path.rglob('*')):
        if path.is_file():
            archive.write(path, path.relative_to(root_path).as_posix())
`, out, stage]);
rmSync(stage, { recursive: true, force: true });
const bytes = readFileSync(out);
console.log(`${basename(out)} ${(statSync(out).size / 1024).toFixed(1)} KB`);
console.log(`sha256 ${createHash('sha256').update(bytes).digest('hex')}`);
