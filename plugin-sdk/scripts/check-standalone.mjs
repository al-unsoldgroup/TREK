import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// A sibling workspace can hide undeclared imports. Check an isolated copy.
const source = fileURLToPath(new URL('../', import.meta.url));
const stage = mkdtempSync(join(tmpdir(), 'trek-sdk-standalone-'));
try {
  for (const name of ['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.cjs.json', 'src', 'scripts']) {
    cpSync(join(source, name), join(stage, name), { recursive: true });
  }
  for (const args of [['ci', '--no-audit', '--no-fund'], ['run', 'typecheck'], ['run', 'build']]) {
    const result = spawnSync('npm', args, { cwd: stage, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Standalone SDK check failed: npm ${args.join(' ')}`);
  }
} finally {
  rmSync(stage, { recursive: true, force: true });
}
