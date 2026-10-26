#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
const dir = resolve(process.argv[2] || '.');
const manifest = JSON.parse(readFileSync(join(dir, 'trek-plugin.json'), 'utf8'));
const checks = [
  ['manifest id', manifest.id === 'trip-advice'],
  ['native public-share surface', manifest.capabilities?.publicShare?.version === 2 && manifest.capabilities.publicShare.surface === 'native'],
  ['v1 compatibility asset', existsSync(join(dir, 'client/guest.html'))],
  ['server entry', existsSync(join(dir, 'server/index.js'))],
  ['no provider egress', !manifest.egress?.length]
];
for (const [name, ok] of checks) console.log(`${ok ? 'ok' : 'FAIL'} ${name}`);
if (checks.some(([, ok]) => !ok)) process.exit(1);
