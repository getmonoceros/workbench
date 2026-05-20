import { defineCommand } from 'citty';
import { consola } from 'consola';
import { runAddFromUrl } from '../modify/index.js';

export const addFromUrlCommand = defineCommand({
  meta: {
    name: 'add-from-url',
    group: 'edit',
    description:
      'Add an https:// install URL to the container config. The URL gets piped to sh on every container rebuild. Loudly warns about remote-code execution before persisting. Idempotent.',
  },
  args: {
    name: {
      type: 'positional',
      description:
        'Container name (yml in $MONOCEROS_HOME/container-configs/).',
      required: true,
    },
    url: {
      type: 'positional',
      description:
        'https:// URL of an install script (e.g. https://starship.rs/install.sh).',
      required: true,
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
    if (!args.yes) {
      printSecurityWarning(args.url);
    }
    try {
      const result = await runAddFromUrl({
        name: args.name,
        url: args.url,
        yes: args.yes,
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
  w('  This URL will be fetched and piped to sh on every container rebuild.');
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
