import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { consola } from 'consola';

/**
 * Spawn signature for `git config --global --get <key>`: takes the
 * key, returns stdout (trimmed) and exit code. Exit code 1 with empty
 * stdout means "no value set" — that's how git signals an unset key.
 * Injected by tests.
 */
export type IdentitySpawn = (
  key: string,
) => Promise<{ value: string; exitCode: number }>;

/**
 * Async prompt for a single identity key. Used as a fallback when the
 * host has no `--global` identity and `.monoceros/gitconfig` has no
 * persisted value from an earlier run. Returns the entered value or
 * `undefined` if the builder skips.
 */
export type IdentityPrompt = (
  key: 'user.name' | 'user.email',
) => Promise<string | undefined>;

/**
 * Persistence target the builder chose for a freshly-prompted or
 * previously-persisted identity. `'g'` writes to
 * `~/.monoceros/monoceros-config.yml` (global default for every
 * container), `'c'` writes to the container yml's `git.user`, `'b'`
 * does both, `'n'` skips persistence (keep using whatever transient
 * source we have — typically `.monoceros/gitconfig` from a prior
 * apply). The caller (apply / init) does the actual yml writes —
 * collectGitIdentity just surfaces what the builder picked so the
 * caller can act on it.
 */
export type IdentityScope = 'g' | 'c' | 'b' | 'n';

export type IdentityScopePrompt = (
  ctx: IdentityScopePromptContext,
) => Promise<IdentityScope | undefined>;

/**
 * Context passed to the scope prompt so the implementation can show
 * the builder what's going on — `'prompt'` after a fresh
 * name/email entry vs. `'persisted'` after recovering values from
 * `.monoceros/gitconfig`. The default consola prompt renders the
 * actual name/email so the builder sees what they'd be persisting.
 */
export interface IdentityScopePromptContext {
  reason: 'prompt' | 'persisted';
  name: string;
  email: string;
}

const realGitConfigGet: IdentitySpawn = (key) => {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['config', '--global', '--get', key], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on('error', reject);
    child.on('exit', (code) =>
      resolve({ value: stdout.trim(), exitCode: code ?? 0 }),
    );
  });
};

const realIdentityPrompt: IdentityPrompt = async (key) => {
  // Non-interactive (CI, scripts): never hang waiting for input. The
  // identity stays unset; builder fixes it later by setting host
  // `git config --global` or editing `.monoceros/gitconfig` directly.
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return undefined;
  }
  const label =
    key === 'user.name'
      ? 'Git user.name for this dev container (full name)'
      : 'Git user.email for this dev container';
  const value = await consola.prompt(`${label}:`, { type: 'text' });
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const realScopePrompt: IdentityScopePrompt = async (ctx) => {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    // Non-interactive: default to `g` (global) on a fresh prompt
    // entry (the values are new, we want them remembered); default
    // to `n` on the persisted-recovery path (the values were
    // already in .monoceros/gitconfig and a script that hits this
    // path probably doesn't want a silent rewrite of monoceros-config).
    return ctx.reason === 'prompt' ? 'g' : 'n';
  }
  const heading =
    ctx.reason === 'persisted'
      ? `Found identity in .monoceros/gitconfig: ${ctx.name} <${ctx.email}>. Promote where?`
      : 'Save this identity where?';
  const choice = await consola.prompt(heading, {
    type: 'select',
    options: [
      {
        label: 'Globally — every container uses it as default',
        value: 'g',
      },
      {
        label: 'In this container only',
        value: 'c',
      },
      {
        label: 'Both — global default plus container-level entry',
        value: 'b',
      },
      {
        label: 'Keep as-is — do not write to monoceros-config or yml',
        value: 'n',
      },
    ],
    initial: 'g',
  });
  if (choice === 'g' || choice === 'c' || choice === 'b' || choice === 'n') {
    return choice;
  }
  return undefined;
};

export interface CollectIdentityOptions {
  spawn?: IdentitySpawn;
  /**
   * Fallback prompt when the host has no `--global` identity and
   * `.monoceros/gitconfig` has no persisted value either. Tests inject
   * a canned answer; production uses an interactive `consola.prompt`
   * that auto-skips in non-interactive contexts.
   */
  prompt?: IdentityPrompt;
  /**
   * Asked AFTER an interactive identity prompt succeeded: where to
   * persist (global monoceros-config, container yml, both). Result
   * lands in `CollectIdentityResult.promptedScope` for the caller to
   * act on (apply / init handle the actual yml writes).
   */
  scopePrompt?: IdentityScopePrompt;
  /**
   * Per-container override from the container's yml `git.user`. Wins
   * over everything else (host global, workbench-wide defaults,
   * persisted state, interactive prompt).
   */
  containerOverride?: { name?: string; email?: string };
  /**
   * Workbench-wide defaults from `<MONOCEROS_HOME>/monoceros-config.yml`
   * `defaults.git.user`. Wins over host global git config (the
   * monoceros-config.yml is an explicit builder choice for Monoceros
   * containers; host global is the catch-all default), loses to the
   * per-container override.
   */
  defaults?: { name?: string; email?: string };
  logger?: { info: (msg: string) => void; warn: (msg: string) => void };
}

export interface CollectIdentityResult {
  name?: string;
  email?: string;
  gitconfigPath: string;
  /**
   * Set ONLY when the identity should be persisted somewhere new —
   * the builder picked one of the persistence scopes (`g`/`c`/`b`)
   * either after a fresh prompt or after we offered to promote
   * recovered persisted values to monoceros-config. The caller uses
   * this to decide which yml(s) to write.
   *
   * `name` / `email` carry the values to persist so the caller
   * doesn't have to re-fish them out of the result fields above.
   * `'n'` (skip) is filtered out before this surfaces — the field
   * stays `undefined` in that case.
   */
  prompted?: {
    name: string;
    email: string;
    scope: 'g' | 'c' | 'b';
  };
}

/**
 * Extract `user.name` and `user.email` from the host's global git
 * config, write them as `<devContainerRoot>/.monoceros/gitconfig` for
 * the container to include. Done both at `monoceros create` time (so
 * the first `start` has identity) and at every `monoceros apply` (so
 * host changes propagate in).
 *
 * Always writes the file, even when host has nothing set — keeps the
 * include.path target valid (git silently ignores missing files, but
 * present-but-empty is more deterministic).
 *
 * Returns the captured values; the caller can use them for logging.
 * Missing values surface as `undefined`, plus a warn log line.
 */
/**
 * Resolve an identity by walking the precedence chain (override →
 * defaults → host → persisted → prompt). Pure as far as Monoceros
 * state goes: doesn't write the `.monoceros/gitconfig` file —
 * `collectGitIdentity` is the wrapper that does.
 *
 * Used from `init` when a `--with-repo` flag means the builder needs
 * an identity before any container exists yet (and so before
 * `.monoceros/gitconfig` has a target path). Persistence to
 * monoceros-config or container yml is the caller's job either way.
 */
export async function resolveIdentityWithPrompt(
  options: CollectIdentityOptions & {
    persistedValues?: { name?: string; email?: string };
  } = {},
): Promise<{
  name?: string;
  email?: string;
  prompted?: { name: string; email: string; scope: 'g' | 'c' | 'b' };
}> {
  const spawnFn = options.spawn ?? realGitConfigGet;
  const promptFn = options.prompt ?? realIdentityPrompt;
  const scopePromptFn = options.scopePrompt ?? realScopePrompt;
  const logger = options.logger ?? { info: () => {}, warn: () => {} };
  const persisted = options.persistedValues ?? {};

  const name = await resolveKey('user.name', {
    override: options.containerOverride?.name,
    defaultValue: options.defaults?.name,
    spawnFn,
    persistedValue: persisted.name,
    promptFn,
    logger,
  });
  const email = await resolveKey('user.email', {
    override: options.containerOverride?.email,
    defaultValue: options.defaults?.email,
    spawnFn,
    persistedValue: persisted.email,
    promptFn,
    logger,
  });

  // Scope-prompt triggers when both keys came from the same
  // "promotable" source AND the identity hasn't already been
  // canonicalised in the yml ladder (container override / global
  // defaults).
  //
  //   - `prompt`: fresh entry → ask where to persist (default `g`)
  //   - `persisted`: recovered from .monoceros/gitconfig of a prior
  //     apply → ask whether to promote to monoceros-config now that
  //     the global defaults are empty (default `n` on non-TTY)
  //
  // `host` source is treated as "the builder's machine-wide default,
  // not ours to promote" and never triggers the prompt — host
  // changes can drift while Monoceros sleeps.
  const alreadyCanonical =
    !!options.containerOverride?.name ||
    !!options.containerOverride?.email ||
    !!options.defaults?.name ||
    !!options.defaults?.email;
  const promptableSources: ReadonlyArray<IdentitySource> = [
    'prompt',
    'persisted',
  ];
  const bothPromotable =
    name?.source !== undefined &&
    email?.source !== undefined &&
    promptableSources.includes(name.source) &&
    promptableSources.includes(email.source) &&
    name.source === email.source;

  let promptedScope: IdentityScope | undefined;
  if (!alreadyCanonical && bothPromotable && name?.value && email?.value) {
    promptedScope = await scopePromptFn({
      reason: name.source as 'prompt' | 'persisted',
      name: name.value,
      email: email.value,
    });
  }

  return {
    ...(name?.value !== undefined ? { name: name.value } : {}),
    ...(email?.value !== undefined ? { email: email.value } : {}),
    // Only surface `prompted` when the scope is a persistence target
    // (`g`/`c`/`b`). `'n'` means "do nothing" — no point passing it
    // to the caller as a "go persist" signal.
    ...(promptedScope && promptedScope !== 'n' && name?.value && email?.value
      ? {
          prompted: {
            name: name.value,
            email: email.value,
            scope: promptedScope,
          },
        }
      : {}),
  };
}

export async function collectGitIdentity(
  devContainerRoot: string,
  options: CollectIdentityOptions = {},
): Promise<CollectIdentityResult> {
  const gitconfigDir = path.join(devContainerRoot, '.monoceros');
  const gitconfigPath = path.join(gitconfigDir, 'gitconfig');
  const logger = options.logger ?? { info: () => {}, warn: () => {} };

  const existing = await readExistingGitconfig(gitconfigPath);

  const resolved = await resolveIdentityWithPrompt({
    ...options,
    persistedValues: existing,
    logger,
  });

  const lines: string[] = ['[user]'];
  if (resolved.name !== undefined) lines.push(`\tname = ${resolved.name}`);
  if (resolved.email !== undefined) lines.push(`\temail = ${resolved.email}`);

  await fs.mkdir(gitconfigDir, { recursive: true });
  await fs.writeFile(gitconfigPath, lines.join('\n') + '\n');

  return {
    ...(resolved.name !== undefined ? { name: resolved.name } : {}),
    ...(resolved.email !== undefined ? { email: resolved.email } : {}),
    gitconfigPath,
    ...(resolved.prompted ? { prompted: resolved.prompted } : {}),
  };
}

interface ResolveKeyOpts {
  override?: string;
  defaultValue?: string;
  spawnFn: IdentitySpawn;
  persistedValue?: string;
  promptFn: IdentityPrompt;
  logger: { warn: (msg: string) => void };
}

type IdentitySource =
  | 'container'
  | 'defaults'
  | 'host'
  | 'persisted'
  | 'prompt';

interface ResolvedKey {
  value: string;
  source: IdentitySource;
}

async function resolveKey(
  key: 'user.name' | 'user.email',
  opts: ResolveKeyOpts,
): Promise<ResolvedKey | undefined> {
  if (opts.override !== undefined && opts.override.length > 0) {
    return { value: opts.override, source: 'container' };
  }
  if (opts.defaultValue !== undefined && opts.defaultValue.length > 0) {
    return { value: opts.defaultValue, source: 'defaults' };
  }
  const hostValue = await readKeyFromHost(opts.spawnFn, key, opts.logger);
  if (hostValue !== undefined) return { value: hostValue, source: 'host' };
  if (opts.persistedValue !== undefined && opts.persistedValue.length > 0) {
    return { value: opts.persistedValue, source: 'persisted' };
  }
  const prompted = await opts.promptFn(key);
  if (prompted !== undefined) return { value: prompted, source: 'prompt' };
  opts.logger.warn(
    `No ${key} resolvable (yml override, monoceros-config.yml defaults, host \`git config --global\`, persisted .monoceros/gitconfig, prompt). Container git will have no ${key} until set explicitly.`,
  );
  return undefined;
}

async function readKeyFromHost(
  spawnFn: IdentitySpawn,
  key: string,
  logger: { warn: (msg: string) => void },
): Promise<string | undefined> {
  try {
    const result = await spawnFn(key);
    if (result.exitCode === 0 && result.value.length > 0) {
      return result.value;
    }
    return undefined;
  } catch (err) {
    logger.warn(
      `Host git not runnable (${err instanceof Error ? err.message : String(err)}); identity not captured.`,
    );
    return undefined;
  }
}

async function readExistingGitconfig(
  filePath: string,
): Promise<{ name?: string; email?: string }> {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const result: { name?: string; email?: string } = {};
    const nameMatch = /^\s*name\s*=\s*(.+?)\s*$/m.exec(content);
    const emailMatch = /^\s*email\s*=\s*(.+?)\s*$/m.exec(content);
    if (nameMatch?.[1]) result.name = nameMatch[1];
    if (emailMatch?.[1]) result.email = emailMatch[1];
    return result;
  } catch {
    return {};
  }
}
