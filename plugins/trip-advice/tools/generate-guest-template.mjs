import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve(process.argv[2] || '.');
const html = readFileSync(resolve(root, 'client/guest.html'), 'utf8');
const body = html.match(/<body>([\s\S]*?)<\/body>/)?.[1];
if (!body) throw new Error('Guest page has no body');
const markup = body.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').trim();
const output = '// Generated from guest.html. Run node tools/generate-guest-template.mjs .\n' +
  'globalThis.TrekAdviceGuestMarkup = ' + JSON.stringify(markup) + ';\n';
const target = resolve(root, 'client/advice-guest-template.js');
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8') !== output) throw new Error('Guest preview template is stale');
} else writeFileSync(target, output);
