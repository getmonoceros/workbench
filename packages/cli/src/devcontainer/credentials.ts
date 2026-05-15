import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { RepoEntry } from '../create/types.js';

/**
 * Spawn signature for `git credential fill`: takes the credential-
 * protocol input on stdin, returns the helper's response on stdout
 * plus the process exit code. Injected by tests.
 */
export type CredentialsSpawn = (
  input: string,
) => Promise<{ stdout: string; exitCode: number }>;

const realGitCredentialFill: CredentialsSpawn = (input) => {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['credential', 'fill'], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ stdout, exitCode: code ?? 0 }));
    child.stdin.write(input);
    child.stdin.end();
  });
};

function uniqueHttpsHosts(repos: readonly RepoEntry[]): string[] {
  const hosts = new Set<string>();
  for (const repo of repos) {
    if (!repo.url.startsWith('https://')) continue;
    try {
      hosts.add(new URL(repo.url).hostname);
    } catch {
      // Skip malformed URLs — validateOptions catches them at the
      // add-repo step, so reaching this in production means a stack
      // file was hand-edited. Don't fail the whole apply for it.
    }
  }
  return [...hosts];
}

interface ParsedCreds {
  username?: string;
  password?: string;
}

function parseCredentialFillOutput(output: string): ParsedCreds {
  const result: ParsedCreds = {};
  for (const line of output.split('\n')) {
    const eqIdx = line.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = line.slice(0, eqIdx);
    const value = line.slice(eqIdx + 1);
    if (key === 'username') result.username = value;
    if (key === 'password') result.password = value;
  }
  return result;
}

function formatCredentialLine(
  host: string,
  username: string,
  password: string,
): string {
  // Both fields percent-encoded so a `@`, `:`, or `/` in the token
  // doesn't break URL parsing inside git's `store` helper.
  const encUser = encodeURIComponent(username);
  const encPass = encodeURIComponent(password);
  return `https://${encUser}:${encPass}@${host}`;
}

export interface CollectCredentialsOptions {
  spawn?: CredentialsSpawn;
  logger?: { info: (msg: string) => void; warn: (msg: string) => void };
}

export interface CollectCredentialsResult {
  /** Number of hosts for which credentials were successfully written. */
  hostsWritten: number;
  /** Number of hosts for which `git credential fill` failed or returned no creds. */
  hostsSkipped: number;
  /** Absolute path to the written credentials file (always written, possibly empty). */
  credentialsPath: string;
}

/**
 * For each unique HTTPS host across the dev-container's repos, ask the
 * host-side git for credentials and write them to
 * `<devContainerRoot>/.monoceros/git-credentials`. The container's
 * post-create.sh configures git to read from that file via `store`
 * credential helper.
 *
 * Host-side `git credential fill` consults whatever helper the host
 * has configured (osxkeychain on macOS, manager on Windows, libsecret
 * on Linux). If a helper has the cached credentials, returns silent.
 * If not, the helper prompts the builder via its native UI
 * (Keychain-popup, GCM-window, terminal-prompt). That's the intended
 * UX — Monoceros never prompts directly, the host's helper does.
 *
 * Always writes the file (possibly empty) so the bind-mount target
 * exists in the container. A host that returns no credentials simply
 * yields a credentials file with no matching entries, and the in-
 * container `git clone` falls back to whatever default git would do
 * (which is to prompt — and there we lose, but the diagnostic is
 * clear).
 */
export async function collectGitCredentials(
  devContainerRoot: string,
  repos: readonly RepoEntry[],
  options: CollectCredentialsOptions = {},
): Promise<CollectCredentialsResult> {
  const credsDir = path.join(devContainerRoot, '.monoceros');
  const credentialsPath = path.join(credsDir, 'git-credentials');

  const hosts = uniqueHttpsHosts(repos);
  const spawnFn = options.spawn ?? realGitCredentialFill;
  const logger = options.logger ?? { info: () => {}, warn: () => {} };

  const lines: string[] = [];
  let hostsSkipped = 0;
  for (const host of hosts) {
    logger.info(`Fetching credentials for ${host} from host git…`);
    const input = `protocol=https\nhost=${host}\n\n`;
    let result;
    try {
      result = await spawnFn(input);
    } catch (err) {
      logger.warn(
        `git credential fill not runnable for ${host} (${err instanceof Error ? err.message : String(err)}); skipping.`,
      );
      hostsSkipped += 1;
      continue;
    }
    if (result.exitCode !== 0) {
      logger.warn(
        `git credential fill exited ${result.exitCode} for ${host}; container clone will prompt.`,
      );
      hostsSkipped += 1;
      continue;
    }
    const { username, password } = parseCredentialFillOutput(result.stdout);
    if (!username || !password) {
      logger.warn(
        `git credential fill returned no username/password for ${host}; container clone will prompt.`,
      );
      hostsSkipped += 1;
      continue;
    }
    lines.push(formatCredentialLine(host, username, password));
  }

  await fs.mkdir(credsDir, { recursive: true });
  await fs.writeFile(
    credentialsPath,
    lines.join('\n') + (lines.length > 0 ? '\n' : ''),
    {
      mode: 0o600,
    },
  );

  return {
    hostsWritten: lines.length,
    hostsSkipped,
    credentialsPath,
  };
}

// Exported for tests.
export const _internals = {
  uniqueHttpsHosts,
  parseCredentialFillOutput,
  formatCredentialLine,
};
