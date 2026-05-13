import { defineCommand } from 'citty';
import { consola } from 'consola';
import { runAddFromUrl } from '../modify/index.js';
import { CLI_VERSION } from '../version.js';

export const addFromUrlCommand = defineCommand({
  meta: {
    name: 'add-from-url',
    description:
      'Add an https:// install URL that gets piped to bash on every container rebuild (`bash <(curl -fsSL <url>)`). Loudly warns about remote-code execution before persisting. Idempotent.',
  },
  args: {
    url: {
      type: 'positional',
      description:
        'https:// URL of an install script (e.g. https://teamwork-graph.atlassian.com/cli/install).',
      required: true,
    },
    project: {
      type: 'string',
      description:
        'Override the auto-detected project (path, absolute or relative to cwd).',
    },
    yes: {
      type: 'boolean',
      description:
        'Skip the security warning + diff confirm. Use only in scripts where you have already audited the URL.',
      alias: ['y'],
      default: false,
    },
  },
  async run({ args }) {
    const url = String(args.url);

    // Loud security warning. Print before runAddFromUrl so the builder
    // sees it above the diff preview (which appears as part of the
    // normal mutate flow).
    if (!args.yes) {
      printSecurityWarning(url);
    }

    try {
      const result = await runAddFromUrl({
        url,
        project: typeof args.project === 'string' ? args.project : undefined,
        yes: args.yes,
        cliVersion: CLI_VERSION,
      });
      process.exit(result.status === 'aborted' ? 1 : 0);
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});

function printSecurityWarning(url: string): void {
  const w = (line: string) => process.stderr.write(line + '\n');
  w('');
  w('⚠️  SECURITY WARNING — `monoceros add-from-url`');
  w('');
  w(`  URL: ${url}`);
  w('');
  w('  This URL will be fetched and piped to bash on every container rebuild.');
  w(
    '  Remote-code execution against a URL you do not control is a supply-chain',
  );
  w(
    '  risk: the maintainer could change the script tomorrow and your container',
  );
  w('  would silently run the new payload.');
  w('');
  w('  Before confirming below:');
  w('    1. Open the URL in a browser, read what the script does.');
  w(
    '    2. Verify the maintainer is who you think they are (HTTPS cert, repo).',
  );
  w('    3. Ideally, vendor the install steps as `add-apt-packages` or');
  w(
    '       `add-feature` instead — those reference signed/versioned artifacts.',
  );
  w('');
}
