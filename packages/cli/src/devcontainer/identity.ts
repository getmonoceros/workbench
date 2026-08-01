import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { consola } from 'consola';
import { GIT_IDENTITY_VAR } from '../config/env-file.js';

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
 * declared source carries one. Returns the entered value or
 * `undefined` if the builder skips.
 */
export type IdentityPrompt = (
  key: 'user.name' | 'user.email',
) => Promise<string | undefined>;

/**
 * Persistence target the builder chose for a freshly-prompted
 * identity. `'g'` writes `GIT_USER_NAME` / `GIT_USER_EMAIL` to
 * `<MONOCEROS_HOME>/monoceros-config.env` (every container), `'c'`
 * writes them to the container's own `<name>.env`, `'b'` does both,
 * `'n'` saves nothing and the question comes back on the next apply.
 *
 * The env, not the yml: a name and an address are personal data, and
 * the env files are the gitignored half. The caller (apply / init)
 * does the writes; collectGitIdentity only surfaces the pick.
 */
export type IdentityScope = 'g' | 'c' | 'b' | 'n';

export type IdentityScopePrompt = (
  ctx: IdentityScopePromptContext,
) => Promise<IdentityScope | undefined>;

/**
 * Context passed to the scope prompt so the implementation can show
 * the builder what's going on — `'prompt'` after a fresh
 * name/email entry. The default consola prompt renders the actual
 * name/email so the builder sees what they would be saving.
 */
export interface IdentityScopePromptContext {
  reason: 'prompt';
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
    // Non-interactive: remember it globally. The values are new and
    // nothing else holds them, so not saving would mean asking again
    // on every apply.
    return 'g';
  }
  const heading = `Save ${ctx.name} <${ctx.email}> where?`;
  const choice = await consola.prompt(heading, {
    type: 'select',
    options: [
      {
        label: 'Globally - monoceros-config.env, every container uses it',
        value: 'g',
      },
      {
        label: 'In this container only - its own <name>.env',
        value: 'c',
      },
      {
        label: 'Both',
        value: 'b',
      },
      {
        label: 'Do not save - you will be asked again on the next apply',
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
   * Fallback prompt when no declared source carries an identity and
   * the host has no `--global` one either. Tests inject a canned
   * answer; production uses an interactive `consola.prompt` that
   * auto-skips in non-interactive contexts.
   */
  prompt?: IdentityPrompt;
  /**
   * Asked AFTER an interactive identity prompt succeeded: which env
   * file to save it in. Result lands in `CollectIdentityResult.prompted`
   * for the caller to act on (apply / init do the writes).
   */
  scopePrompt?: IdentityScopePrompt;
  /**
   * Per-container override from the container's yml `git.user`. Wins
   * over everything else (env, workbench-wide defaults, host global,
   * interactive prompt).
   */
  containerOverride?: { name?: string; email?: string };
  /**
   * `GIT_USER_NAME` / `GIT_USER_EMAIL` from the merged env (global
   * `monoceros-config.env` plus the container's own `<name>.env`).
   *
   * A first-class source, not a yml placeholder: a name and an address
   * are personal data, the env file is where those belong, and it is
   * gitignored. Requiring a `git.user: ${GIT_USER_NAME}` line in the yml
   * to activate them made the env inert for every workbench that had no
   * repos, because only `init --with-repos` ever wrote that line.
   */
  env?: { name?: string; email?: string };
  /**
   * Workbench-wide defaults from `<MONOCEROS_HOME>/monoceros-config.yml`
   * `defaults.git.user`. Wins over host global git config (the
   * monoceros-config.yml is an explicit builder choice for Monoceros
   * containers; host global is the catch-all default), loses to the
   * per-container override and to the env.
   */
  defaults?: { name?: string; email?: string };
  logger?: { info: (msg: string) => void; warn: (msg: string) => void };
}

export interface CollectIdentityResult {
  name?: string;
  email?: string;
  gitconfigPath: string;
  /**
   * Set ONLY when a fresh prompt produced an identity and the builder
   * picked a place to keep it (`g`/`c`/`b`). The caller uses this to
   * decide which env file(s) to write.
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
 * Resolve an identity by walking the precedence chain (override → env →
 * defaults → host → prompt). Pure as far as Monoceros state goes:
 * doesn't write the `.monoceros/gitconfig` file - `collectGitIdentity`
 * is the wrapper that does.
 *
 * Every step is a source the builder declared somewhere they can edit.
 * `.monoceros/gitconfig` is deliberately NOT among them, even though we
 * write it on every apply: a generated file that is also an input keeps
 * itself alive, so an identity survived the removal of the thing that
 * produced it. Comment the variables out, apply, and the container
 * still committed under the old name. The yml and the env are the
 * source of truth and the container is derived from them, which only
 * holds if deriving can also take something away.
 *
 * Used from `init` when a `--with-repo` flag means the builder needs an
 * identity before any container exists yet. Persisting a prompted
 * answer is the caller's job either way.
 */
export async function resolveIdentityWithPrompt(
  options: CollectIdentityOptions = {},
): Promise<{
  name?: string;
  email?: string;
  prompted?: { name: string; email: string; scope: 'g' | 'c' | 'b' };
}> {
  const spawnFn = options.spawn ?? realGitConfigGet;
  const promptFn = options.prompt ?? realIdentityPrompt;
  const scopePromptFn = options.scopePrompt ?? realScopePrompt;
  const logger = options.logger ?? { info: () => {}, warn: () => {} };

  const name = await resolveKey('user.name', {
    override: options.containerOverride?.name,
    envValue: options.env?.name,
    defaultValue: options.defaults?.name,
    spawnFn,
    promptFn,
    logger,
  });
  const email = await resolveKey('user.email', {
    override: options.containerOverride?.email,
    envValue: options.env?.email,
    defaultValue: options.defaults?.email,
    spawnFn,
    promptFn,
    logger,
  });

  // Only a fresh prompt asks where to keep the answer, and only when
  // no declared source already holds one. Typing a name and getting
  // nothing saved would mean the same question on the next apply.
  //
  // `host` never triggers it: that is the builder's machine-wide
  // default, not ours to copy into their workbench, and it can drift
  // while Monoceros sleeps.
  const alreadyCanonical =
    !!options.containerOverride?.name ||
    !!options.containerOverride?.email ||
    !!options.env?.name ||
    !!options.env?.email ||
    !!options.defaults?.name ||
    !!options.defaults?.email;
  const promptableSources: ReadonlyArray<IdentitySource> = ['prompt'];
  const bothPromotable =
    name?.source !== undefined &&
    email?.source !== undefined &&
    promptableSources.includes(name.source) &&
    promptableSources.includes(email.source) &&
    name.source === email.source;

  let promptedScope: IdentityScope | undefined;
  if (!alreadyCanonical && bothPromotable && name?.value && email?.value) {
    promptedScope = await scopePromptFn({
      reason: 'prompt',
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

  const resolved = await resolveIdentityWithPrompt({ ...options, logger });

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
  envValue?: string;
  defaultValue?: string;
  spawnFn: IdentitySpawn;
  promptFn: IdentityPrompt;
  logger: { warn: (msg: string) => void };
}

type IdentitySource = 'container' | 'env' | 'defaults' | 'host' | 'prompt';

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
  const envValue = opts.envValue?.trim();
  if (envValue !== undefined && envValue.length > 0) {
    return { value: envValue, source: 'env' };
  }
  if (opts.defaultValue !== undefined && opts.defaultValue.length > 0) {
    return { value: opts.defaultValue, source: 'defaults' };
  }
  const hostValue = await readKeyFromHost(opts.spawnFn, key, opts.logger);
  if (hostValue !== undefined) return { value: hostValue, source: 'host' };
  const prompted = await opts.promptFn(key);
  if (prompted !== undefined) return { value: prompted, source: 'prompt' };
  opts.logger.warn(
    `No ${key} resolvable (env ${key === 'user.name' ? GIT_IDENTITY_VAR.name : GIT_IDENTITY_VAR.email}, yml override, monoceros-config.yml defaults, host \`git config --global\`, prompt). Container git will have no ${key} until set explicitly.`,
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
