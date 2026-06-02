import { defineCommand } from 'citty';
import { consola } from 'consola';
import { runInit } from '../init/index.js';

export const initCommand = defineCommand({
  meta: {
    name: 'init',
    group: 'lifecycle',
    description:
      'Create a fresh container-config yml at <MONOCEROS_HOME>/container-configs/<name>.yml. Without any --with-* flag, the file is a documented default with every component commented out. With --with-languages / --with-features / --with-services / --with-apt-packages, the named pieces are composed into an active, immediately-applyable yml. Then run `monoceros apply <name>`.',
  },
  args: {
    name: {
      type: 'positional',
      description:
        'Config name. The yml lands at <MONOCEROS_HOME>/container-configs/<name>.yml and becomes the source-of-truth for `monoceros apply <name>`.',
      required: true,
    },
    'with-languages': {
      type: 'string',
      description:
        'Language runtimes to install, comma-separated or repeated, e.g. --with-languages=java,node. Optional :version (java:17). Curated catalog only — see `monoceros list-components`.',
      required: false,
    },
    'with-features': {
      type: 'string',
      description:
        'Features (AI tools, language CLIs, …), comma-separated or repeated. Catalog short name (claude, atlassian/twg) or a full OCI ref (ghcr.io/foo/bar:1).',
      required: false,
    },
    'with-services': {
      type: 'string',
      description:
        'Backing services, comma-separated or repeated. Curated name (postgres, mysql, redis) → full editable block; any other image (rustfs/rustfs:latest) → name + image + commented scaffold.',
      required: false,
    },
    'with-apt-packages': {
      type: 'string',
      description:
        'Debian/Ubuntu apt packages to install, comma-separated or repeated, e.g. --with-apt-packages=openssl,make. No curated list.',
      required: false,
    },
    'with-repos': {
      type: 'string',
      description:
        'Git URLs to clone into projects/ on first apply, comma-separated or repeated. Folder name derived from URL (foo.git → projects/foo/); use `monoceros add-repo --path=...` post-init for subfolder paths. Canonical hosts only (github.com / gitlab.com / bitbucket.org).',
      required: false,
    },
    'with-ports': {
      type: 'string',
      description:
        'Comma-separated list of container-internal ports to expose via Traefik, e.g. --with-ports=3000,5173,6006. First entry doubles as http://<name>.localhost (default route). Equivalent to `monoceros add-port` after init. Each must be an integer in 1–65535.',
      required: false,
    },
  },
  async run({ args, rawArgs }) {
    try {
      const languages = collectListFlag('--with-languages', rawArgs);
      const features = collectListFlag('--with-features', rawArgs);
      const services = collectListFlag('--with-services', rawArgs);
      const aptPackages = collectListFlag('--with-apt-packages', rawArgs);
      const repos = collectListFlag('--with-repos', rawArgs);
      const ports = collectWithPortsList(args['with-ports'], rawArgs);
      await runInit({
        name: args.name,
        ...(languages.length > 0 ? { languages } : {}),
        ...(features.length > 0 ? { features } : {}),
        ...(services.length > 0 ? { services } : {}),
        ...(aptPackages.length > 0 ? { aptPackages } : {}),
        ...(repos.length > 0 ? { withRepo: repos } : {}),
        ...(ports && ports.length > 0 ? { withPorts: ports } : {}),
      });
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});

/**
 * Collect every value for a repeatable comma-list flag from rawArgs.
 * Handles all three shapes the shell can produce:
 *   --flag=a,b        → ['a','b']
 *   --flag a b        → ['a','b']
 *   --flag=a, b, c    → ['a','b','c']  (shell strips spaces, rest float)
 * citty only keeps the last occurrence of a repeated flag, so we walk
 * rawArgs directly. Returns trimmed, comma-split, non-empty pieces in
 * order of appearance.
 */
export function collectListFlag(flag: string, rawArgs: string[]): string[] {
  const eq = `${flag}=`;
  const pieces: string[] = [];
  for (let i = 0; i < rawArgs.length; i += 1) {
    const t = rawArgs[i]!;
    let scanStart = -1;
    if (t === flag) {
      scanStart = i + 1;
    } else if (t.startsWith(eq)) {
      pieces.push(t.slice(eq.length));
      scanStart = i + 1;
    }
    if (scanStart < 0) continue;
    let j = scanStart;
    while (j < rawArgs.length) {
      const u = rawArgs[j]!;
      if (u.startsWith('-')) break;
      pieces.push(u);
      j += 1;
    }
    i = j - 1;
  }
  return pieces
    .flatMap((s) => s.split(','))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Collect ports from every `--with-ports` occurrence (both `=value`
 * and two-token forms) plus the shell-tokenization fallback for
 * `--with-ports=3000, 5173, 6006` where the shell strips the spaces
 * and leaves bare value tokens after the flag.
 *
 * We walk rawArgs only and ignore the args['with-ports'] value —
 * citty drops earlier occurrences when the flag is repeated, but
 * rawArgs has them all in order.
 *
 * Validation (integer, 1..65535) lives in runInit so the same error
 * surface covers both the CLI and direct runInit callers.
 */
export function collectWithPortsList(
  _withPortsArg: string | undefined,
  rawArgs: string[],
): number[] | undefined {
  const pieces: string[] = [];
  for (let i = 0; i < rawArgs.length; i += 1) {
    const t = rawArgs[i]!;
    let scanStart = -1;
    if (t === '--with-ports') {
      scanStart = i + 1; // value sits after the flag, picked up below
    } else if (t.startsWith('--with-ports=')) {
      pieces.push(t.slice('--with-ports='.length));
      scanStart = i + 1;
    }
    if (scanStart < 0) continue;
    // Sweep subsequent non-flag tokens — covers both the two-token
    // form (`--with-ports VALUE`) and the shell-tokenized
    // `--with-ports=3000, 5173, 6006` case where 5173/6006 land as
    // bare tokens after the flag.
    let j = scanStart;
    while (j < rawArgs.length) {
      const u = rawArgs[j]!;
      if (u.startsWith('-')) break;
      pieces.push(u);
      j += 1;
    }
    // Skip everything we just consumed; the outer i++ resumes at j.
    i = j - 1;
  }
  const parts = pieces
    .flatMap((s) => s.split(','))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) return undefined;
  const out: number[] = [];
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      throw new Error(
        `Invalid port in --with-ports: ${JSON.stringify(p)}. Expected integers between 1 and 65535, comma-separated.`,
      );
    }
    out.push(n);
  }
  return out;
}
