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
export async function collectGitIdentity(
  devContainerRoot: string,
  options: CollectIdentityOptions = {},
): Promise<CollectIdentityResult> {
  const gitconfigDir = path.join(devContainerRoot, '.monoceros');
  const gitconfigPath = path.join(gitconfigDir, 'gitconfig');
  const spawnFn = options.spawn ?? realGitConfigGet;
  const promptFn = options.prompt ?? realIdentityPrompt;
  const logger = options.logger ?? { info: () => {}, warn: () => {} };

  const existing = await readExistingGitconfig(gitconfigPath);

  // Resolution order per key:
  //   1. containerOverride (yml's `git.user`)
  //   2. defaults (monoceros-config.yml's `defaults.git.user`)
  //   3. host `git config --global --get <key>`
  //   4. previously persisted value (.monoceros/gitconfig)
  //   5. interactive prompt (skipped in non-TTY contexts)
  const name = await resolveKey('user.name', {
    override: options.containerOverride?.name,
    defaultValue: options.defaults?.name,
    spawnFn,
    persistedValue: existing.name,
    promptFn,
    logger,
  });
  const email = await resolveKey('user.email', {
    override: options.containerOverride?.email,
    defaultValue: options.defaults?.email,
    spawnFn,
    persistedValue: existing.email,
    promptFn,
    logger,
  });

  const lines: string[] = ['[user]'];
  if (name !== undefined) lines.push(`\tname = ${name}`);
  if (email !== undefined) lines.push(`\temail = ${email}`);

  await fs.mkdir(gitconfigDir, { recursive: true });
  await fs.writeFile(gitconfigPath, lines.join('\n') + '\n');

  return {
    ...(name !== undefined ? { name } : {}),
    ...(email !== undefined ? { email } : {}),
    gitconfigPath,
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

async function resolveKey(
  key: 'user.name' | 'user.email',
  opts: ResolveKeyOpts,
): Promise<string | undefined> {
  if (opts.override !== undefined && opts.override.length > 0) {
    return opts.override;
  }
  if (opts.defaultValue !== undefined && opts.defaultValue.length > 0) {
    return opts.defaultValue;
  }
  const hostValue = await readKeyFromHost(opts.spawnFn, key, opts.logger);
  if (hostValue !== undefined) return hostValue;
  if (opts.persistedValue !== undefined && opts.persistedValue.length > 0) {
    return opts.persistedValue;
  }
  const prompted = await opts.promptFn(key);
  if (prompted !== undefined) return prompted;
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
