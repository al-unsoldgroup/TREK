import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// One remote invocation keeps shared/dist available between build and consumer
// checks. Separate rtest syncs can delete generated workspace output.
if (process.platform !== 'linux') throw new Error('Run advice verification through rtest on Linux, never on the Mac');
const root = fileURLToPath(new URL('../../', import.meta.url));
// The shared build must succeed before anything else: every later check reads
// its generated dist. After that, order is cheapest-signal-first (seconds-long
// static gates before the ~15min suites) and nothing short-circuits, so one
// remote run reports every failure instead of only the first one.
const build = ['run', 'build', '--workspace=shared'];
const commands = [
  ['run', 'test', '--workspace=server', '--', 'tests/integration/plugin-shares.test.ts'],
  ['run', 'typecheck', '--workspaces', '--if-present'],
  ['run', 'typecheck:tests', '--workspace=server'],
  ['--prefix', 'plugin-sdk', 'run', 'typecheck'],
  ['run', 'check:plugin-facts', '--workspace=server'],
  ['run', 'check:plugin-share', '--workspace=server'],
  ['run', 'i18n:parity:strict', '--workspace=shared'],
  ['run', 'test', '--workspace=shared', '--', 'src/plugin-share/plugin-share.schema.spec.ts', 'src/i18n/i18n-permission-wording.spec.ts'],
  ['run', 'test', '--workspace=client', '--',
    'src/api/publicShare.test.ts', 'src/components/Plugins/PublicPluginFrame.test.tsx',
    'src/components/Trips/TripMembersModal.test.tsx', 'src/pages/SharedTripPage.test.tsx',
    'src/components/Settings/LlmConnectionSection.test.tsx', 'src/components/Admin/AddonManager.test.tsx'],
  ['run', 'test', '--workspace=server', '--',
    'tests/unit/nest/llm-parse/clients.test.ts', 'tests/unit/nest/llm-parse/llm-client.factory.test.ts',
    'tests/unit/nest/llm-parse/llm-config.resolver.test.ts', 'tests/unit/nest/llm-parse/llm-parse.service.test.ts',
    'tests/unit/services/llmConfig.test.ts', 'tests/unit/nest/settings.service.test.ts',
    'tests/unit/plugins/google-places.provider.test.ts'],
  ['--prefix', 'plugin-sdk', 'test', '--', 'test/public-share.test.ts', 'test/sdk.test.ts', 'test/permissions-parity.test.ts', 'test/manifest-roundtrip.test.ts'],
  ['run', 'test:ws', '--workspace=server'],
  ['run', 'test:integration', '--workspace=server', '--', '--exclude=tests/integration/plugins/trip-advice-runtime.test.ts'],
  ['run', 'test:unit', '--workspace=server'],
  // Boots the real external addon in the plugin child runtime, so it needs
  // TREK_TRIP_ADVICE_ROOT pointing at a synced addon checkout. Kept separate
  // from the run above, which excludes it.
  ['run', 'test:integration:advice-runtime', '--workspace=server'],
];

// `--only=<arg>` reruns just the checks carrying that exact argument, so a stage
// interrupted by something unrelated can be finished without replaying the ones
// already green. Matching is on a whole argument, not a substring, because
// `--exclude=<path>` and `<path>` would otherwise select each other.
const only = process.argv.slice(2).find((a) => a.startsWith('--only='))?.slice('--only='.length);
const selected = only
  ? commands.filter((args) => args.includes(only) ||
    (only === 'tests/integration/plugins/trip-advice-runtime.test.ts' && args.includes('test:integration:advice-runtime')))
  : commands;
if (only && !selected.length) throw new Error(`--only=${only} matched no check`);

const run = (args) => {
  console.log(`advice verification: npm ${args.join(' ')}`);
  const result = spawnSync('npm', args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
};

if (run(build) !== 0) process.exit(1);
const failed = selected.filter((args) => run(args) !== 0);
console.log(`\nadvice verification summary: ${selected.length - failed.length}/${selected.length} checks passed`);
for (const args of failed) console.log(`  FAILED: npm ${args.join(' ')}`);
if (failed.length) process.exit(1);
