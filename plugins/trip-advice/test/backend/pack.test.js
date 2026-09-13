'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');

const ROOT = join(__dirname, '..', '..');

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'trip-advice-pack-'));
  mkdirSync(join(dir, 'server/lib'), { recursive: true });
  mkdirSync(join(dir, 'client'), { recursive: true });
  writeFileSync(join(dir, 'trek-plugin.json'), JSON.stringify({ id: 'trip-advice', version: '1.0.0' }));
  for (const file of ['server/index.js', 'server/lib/advice-service.js', 'server/lib/advice-store.js', 'server/lib/protocol.js']) writeFileSync(join(dir, file), 'runtime');
  for (const file of ['client/guest.html', 'client/index.html', 'client/advice.js', 'client/advice-model.js', 'client/advice-protocol.js', 'client/advice-owner.js', 'client/advice-guest-template.js', 'client/advice-preview.js', 'client/advice.css']) writeFileSync(join(dir, file), 'runtime');
  return dir;
}

test('packer includes only the explicit runtime allowlist', () => {
  const dir = fixture();
  try {
    writeFileSync(join(dir, 'private-secrets.txt'), 'sentinel-do-not-archive');
    execFileSync(process.execPath, [join(ROOT, 'tools/pack.mjs'), dir], { encoding: 'utf8' });
    const listing = execFileSync('unzip', ['-Z1', join(dir, 'dist/trip-advice-1.0.0.zip')], { encoding: 'utf8' });
    assert.match(listing, /server\/index\.js/);
    assert.match(listing, /client\/advice-owner\.js/);
    assert.doesNotMatch(listing, /private-secrets\.txt/);
    assert.doesNotMatch(listing, /package\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('packer rejects symlinks without reading their targets', () => {
  const dir = fixture();
  try {
    const secret = join(dir, 'outside-secret.txt');
    writeFileSync(secret, 'sentinel-do-not-read');
    symlinkSync(secret, join(dir, 'client/private-link.js'));
    const result = spawnSync(process.execPath, [join(ROOT, 'tools/pack.mjs'), dir], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /symlink is not allowed/);
    assert.equal(readFileSync(secret, 'utf8'), 'sentinel-do-not-read');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
