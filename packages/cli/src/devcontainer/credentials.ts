import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { RepoEntry } from '../create/types.js';
import { KNOWN_PROVIDER_HOSTS, type RepoProvider } from '../config/schema.js';
import { cyan, dim } from '../util/format.js';

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
    // GIT_TERMINAL_PROMPT=0 disables git's interactive
    // username/password fallback. Without this, when no credential
    // helper has an entry for the host, `git credential fill` would
    // open /dev/tty and prompt the user — which hangs apply
    // indefinitely because the parent process is running non-
    // interactively. With the env var set, git returns whatever
    // the helpers produced (possibly empty) and exits cleanly,
    // letting our pre-flight detect "no credentials" reliably.
    //
    // We deliberately do NOT also set GIT_ASKPASS='' / SSH_ASKPASS=''.
    // Empty string is interpreted differently across git versions, and
    // — concretely observed on Windows + Git Credential Manager — it
    // tickles a path where GCM's `store` silently no-ops after a
    // successful OAuth flow. The credential helper IS the right tool
    // for non-interactive credential resolution; the terminal-prompt
    // gate above already takes care of the hang scenario this was
    // meant to guard against.
    const child = spawn('git', ['credential', 'fill'], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
      },
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

/**
 * Tell git's configured credential helpers to persist a credential.
 *
 * Why this exists: `git credential fill` returns credentials but never
 * tells the helper to save them — that step normally happens AFTER git
 * has used the credential successfully against a remote, when git
 * itself calls `git credential approve`. Our pre-flight uses `fill`
 * for a lookup-only check, so the helper's `store` is never reached
 * by the natural git flow, and the OAuth-acquired token GCM returned
 * gets thrown away. Next apply: browser dialog again.
 *
 * Calling `approve` explicitly after a successful `fill` closes the
 * loop: GCM (and gh's helper, and the Atlassian one) write the
 * credential to their persistent store on this call, so subsequent
 * applies (and the in-container clone) find it cached. Idempotent —
 * approve on an already-stored credential is a no-op.
 */
export type CredentialsApprove = (input: string) => Promise<void>;

const realGitCredentialApprove: CredentialsApprove = (input) => {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['credential', 'approve'], {
      stdio: ['pipe', 'ignore', 'inherit'],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
      },
    });
    child.on('error', reject);
    child.on('exit', () => resolve()); // best-effort, non-zero is non-fatal
    child.stdin.write(input);
    child.stdin.end();
  });
};

/**
 * Resolve a host's provider:
 *   - canonical hosts (github.com / gitlab.com / bitbucket.org) →
 *     their fixed provider, ignoring any explicit hint (the canonical
 *     mapping is the source of truth)
 *   - any other host → the explicit hint if given, else 'unknown'
 *
 * Returning 'unknown' triggers the apply pre-flight error that asks
 * the builder to set `provider:` in the yml. We deliberately never
 * guess from hostname patterns ("starts with `gitlab.`" etc.) —
 * those produced wrong results for corporate domains like
 * `git.firma.de` and silently fell through to the generic hint.
 */
export type ResolvedProvider = RepoProvider | 'unknown';

export function resolveProvider(
  host: string,
  explicit?: RepoProvider,
): ResolvedProvider {
  const canonical = KNOWN_PROVIDER_HOSTS[host.toLowerCase()];
  if (canonical) return canonical;
  return explicit ?? 'unknown';
}

export interface HostWithProvider {
  host: string;
  provider: ResolvedProvider;
}

/**
 * Reduce a repo list to one entry per host, carrying along the
 * resolved provider so the pre-flight check can render the right
 * setup hint (or error out with "set provider:" for unknowns).
 *
 * If the same host appears with conflicting provider declarations
 * across multiple repo entries, the first one wins — the apply
 * pre-flight surfaces the conflict as a separate diagnostic before
 * we get here in normal flow. (Schema-level dedup would lock us in
 * before the builder ever sees the warning.)
 */
function uniqueHttpsHosts(repos: readonly RepoEntry[]): HostWithProvider[] {
  const byHost = new Map<string, HostWithProvider>();
  for (const repo of repos) {
    if (!repo.url.startsWith('https://')) continue;
    let host: string;
    try {
      host = new URL(repo.url).hostname;
    } catch {
      // Skip malformed URLs — validateOptions catches them at the
      // add-repo step, so reaching this in production means a stack
      // file was hand-edited. Don't fail the whole apply for it.
      continue;
    }
    if (byHost.has(host)) continue;
    byHost.set(host, { host, provider: resolveProvider(host, repo.provider) });
  }
  return [...byHost.values()];
}

/**
 * Provider-specific setup hint per host. Used in the pre-flight
 * error message when `git credential fill` returns nothing for a
 * host. Shows only the install command for the current host OS —
 * less visual noise, no "is this me?" guesswork for the builder.
 *
 * Provider is resolved upstream (canonical-host lookup or explicit
 * yml field). This function NEVER guesses from hostname patterns;
 * see `resolveProvider` for the rationale.
 */
export function providerSetupHint(
  host: string,
  provider: RepoProvider,
): {
  /** Short title for the host, formatted as "host — Provider". */
  title: string;
  /** Multiline body, left-aligned, no leading indentation. */
  body: string;
} {
  if (provider === 'github') {
    // PAT model (ADR 0031): no host CLI. The token goes in an env file;
    // Monoceros writes it into the in-container git-credentials and the
    // `oauth2` username authenticates over HTTPS (GitHub ignores the
    // username and authenticates by the token).
    const isSaas = host.toLowerCase() === 'github.com';
    const tokenUrl = isSaas
      ? 'https://github.com/settings/tokens'
      : `https://${host}/settings/tokens`;
    return {
      title: `${host} — GitHub`,
      body: [
        'Create a token (classic) with the `repo` scope:',
        cyan(tokenUrl),
        '',
        'Add it to your env (no quotes), then re-run apply:',
        cyan(`${gitTokenEnvVar(host)}=<token>`),
        '',
        `All containers: ${dim('monoceros-config.env')}`,
        `This one only:  ${dim('container-configs/<name>.env')}`,
      ].join('\n'),
    };
  }
  if (provider === 'gitlab') {
    // PAT model (ADR 0031): no host CLI. The `api` scope covers git
    // read+write over HTTPS plus the API (so glab in the container works
    // from the same token); `oauth2:<token>` is GitLab's documented form.
    const isSaas = host.toLowerCase() === 'gitlab.com';
    const tokenUrl = isSaas
      ? 'https://gitlab.com/-/user_settings/personal_access_tokens'
      : `https://${host}/-/user_settings/personal_access_tokens`;
    return {
      title: `${host} — GitLab`,
      body: [
        'Create a personal access token with the `api` scope:',
        cyan(tokenUrl),
        '',
        'Add it to your env (no quotes), then re-run apply:',
        cyan(`${gitTokenEnvVar(host)}=<token>`),
        '',
        `All containers: ${dim('monoceros-config.env')}`,
        `This one only:  ${dim('container-configs/<name>.env')}`,
      ].join('\n'),
    };
  }
  if (provider === 'bitbucket') {
    // Bitbucket has no first-party CLI for git-credentials (no
    // `bb auth login` equivalent to gh/glab), so this is a manual
    // one-time setup either way. The Cloud and Data-Center variants
    // differ in where you get the token and what the username field
    // expects — same pattern as the github / gitlab branches above
    // (canonical SaaS host vs. self-hosted).
    const isCloud = host.toLowerCase() === 'bitbucket.org';
    if (isCloud) {
      return {
        title: `${host} — Bitbucket Cloud`,
        body: [
          'Bitbucket has no first-party CLI for git-credentials, so this',
          'is a manual one-time setup. Generate an Atlassian API token at',
          'https://id.atlassian.com/manage-profile/security/api-tokens',
          '',
          'Then store it via your OS credential helper:',
          cyan(
            `git credential approve <<< $'protocol=https\\nhost=${host}\\nusername=<your-atlassian-email>\\npassword=<token>\\n'`,
          ),
        ].join('\n'),
      };
    }
    return {
      title: `${host} — Bitbucket Data Center`,
      body: [
        'Bitbucket has no first-party CLI for git-credentials, so this',
        'is a manual one-time setup. Generate a personal HTTP access',
        `token in your Bitbucket UI: profile picture (top right on ${host})`,
        '→ Manage account → HTTP access tokens → Create token. Give it',
        'at least repo-read + repo-write scopes for the repos you need.',
        '',
        'Then store it via your OS credential helper:',
        cyan(
          `git credential approve <<< $'protocol=https\\nhost=${host}\\nusername=<your-bitbucket-username>\\npassword=<token>\\n'`,
        ),
      ].join('\n'),
    };
  }
  // provider === 'gitea' — Gitea is always self-hosted (gitea.com is
  // a demo / sandbox, not a SaaS), so there's no canonical-host
  // branch. The `tea` CLI exists but logs into its own config and
  // doesn't register as a git credential helper (verified against
  // https://gitea.com/gitea/tea), so we point at the UI flow + a
  // direct `git credential approve` — same pattern as Bitbucket
  // Data Center. Forgejo (the Gitea fork) shares this flow exactly.
  return {
    title: `${host} — Gitea`,
    body: [
      'Gitea has no first-party CLI helper for git-credentials (the',
      '`tea` CLI logs into its own config, not into your git credential',
      'helper), so this is a manual one-time setup. Generate an access',
      `token in your Gitea UI: profile picture (top right on ${host}) →`,
      'Settings → Applications → "Generate New Token". Give it at',
      'least the `read:repository` scope (add `write:repository` if you',
      'need push from the container).',
      '',
      'Then store it via your OS credential helper:',
      cyan(
        `git credential approve <<< $'protocol=https\\nhost=${host}\\nusername=<your-gitea-username>\\npassword=<token>\\n'`,
      ),
    ].join('\n'),
  };
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

/**
 * Env-var name carrying a Personal Access Token for `host` (ADR 0031):
 * `MONOCEROS_GIT_TOKEN__<host>`, with every non-alphanumeric char in the
 * host folded to `_` (github.com -> MONOCEROS_GIT_TOKEN__github_com,
 * gitlab.example.de -> MONOCEROS_GIT_TOKEN__gitlab_example_de). Read from
 * the merged env (global monoceros-config.env under per-container
 * <name>.env).
 */
export function gitTokenEnvVar(host: string): string {
  return `MONOCEROS_GIT_TOKEN__${host.replace(/[^A-Za-z0-9]/g, '_')}`;
}

export interface CollectCredentialsOptions {
  spawn?: CredentialsSpawn;
  /**
   * Approve callback — called once per host after a successful
   * `fill`, with the full credential-protocol payload (incl. password).
   * Tells the host's credential helper to persist the credential.
   * Defaults to `git credential approve`. Tests inject a stub that
   * records calls without spawning git.
   */
  approve?: CredentialsApprove;
  /**
   * Merged env (global monoceros-config.env under per-container
   * <name>.env). When it carries a PAT for a host (see `gitTokenEnvVar`),
   * that token is used directly with no host `git credential fill` spawn
   * and takes precedence over the keychain. Hosts without a configured
   * PAT fall back to the keychain fill path (ADR 0031).
   */
  envVars?: Record<string, string>;
  logger?: { info: (msg: string) => void; warn: (msg: string) => void };
}

export interface HostCredentialStatus {
  host: string;
  /**
   * Resolved provider for this host — canonical lookup for the three
   * known hosts, explicit yml hint for anything else. Carried into
   * the failure message so `formatMissingCredentialsError` can render
   * the right setup block without re-resolving.
   */
  provider: RepoProvider;
  /** 'ok' when username+password came back from `git credential fill`. */
  status: 'ok' | 'no-credentials' | 'spawn-error' | 'non-zero-exit';
  /** Diagnostic text — empty when status is 'ok'. */
  detail: string;
}

export interface CollectCredentialsResult {
  /** Hosts for which credentials were successfully written. */
  hostsWritten: number;
  /** Hosts for which `git credential fill` failed or returned no creds. */
  hostsSkipped: number;
  /** Per-host status (in input order). */
  perHost: HostCredentialStatus[];
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
  hosts: readonly HostWithProvider[],
  options: CollectCredentialsOptions = {},
): Promise<CollectCredentialsResult> {
  const credsDir = path.join(devContainerRoot, '.monoceros');
  const credentialsPath = path.join(credsDir, 'git-credentials');

  const spawnFn = options.spawn ?? realGitCredentialFill;
  const approveFn = options.approve ?? realGitCredentialApprove;
  const logger = options.logger ?? { info: () => {}, warn: () => {} };

  // Callers must filter out 'unknown' providers before invoking this
  // function — those should fail the apply pre-flight earlier with a
  // "set provider:" error, never reach the credential helper. We
  // narrow the type here for the renderer's sake.
  const lines: string[] = [];
  const perHost: HostCredentialStatus[] = [];
  for (const { host, provider } of hosts) {
    if (provider === 'unknown') {
      // Defensive: should not happen — pre-flight is supposed to
      // bail before this. Record it anyway with no-credentials so
      // the caller doesn't see a partial success.
      perHost.push({
        host,
        provider: 'github', // placeholder — never rendered because pre-flight already bailed
        status: 'no-credentials',
        detail: 'provider not declared (internal: should not reach here)',
      });
      continue;
    }
    // PAT path (ADR 0031): if a token is configured for this host in the
    // merged env, use it directly with username `oauth2`, which
    // authenticates over HTTPS for GitHub (username ignored, token is the
    // password) and GitLab (documented oauth2:<token> form). No
    // `git credential fill` spawn: this is the tooling-free default and
    // wins over the keychain when a token is present. Gated to those two
    // providers, the only ones with a verified uniform oauth2 form;
    // Bitbucket/Gitea keep the keychain path (their username differs).
    const patToken =
      provider === 'github' || provider === 'gitlab'
        ? options.envVars?.[gitTokenEnvVar(host)]
        : undefined;
    if (patToken) {
      lines.push(formatCredentialLine(host, 'oauth2', patToken));
      perHost.push({
        host,
        provider,
        status: 'ok',
        detail: 'from PAT (monoceros-config.env)',
      });
      continue;
    }

    logger.info(`Fetching credentials for ${host} from host git…`);
    const input = `protocol=https\nhost=${host}\n\n`;
    let result;
    try {
      result = await spawnFn(input);
    } catch (err) {
      // No logger.warn here — the caller (apply pre-flight) renders
      // a consolidated, provider-specific error message per failing
      // host. A separate WARN line per host would just add visual
      // noise above the actionable error.
      const detail = err instanceof Error ? err.message : String(err);
      perHost.push({ host, provider, status: 'spawn-error', detail });
      continue;
    }
    if (result.exitCode !== 0) {
      perHost.push({
        host,
        provider,
        status: 'non-zero-exit',
        detail: `exit code ${result.exitCode}`,
      });
      continue;
    }
    const { username, password } = parseCredentialFillOutput(result.stdout);
    if (!username || !password) {
      perHost.push({
        host,
        provider,
        status: 'no-credentials',
        detail: 'host credential helper returned no username/password',
      });
      continue;
    }
    lines.push(formatCredentialLine(host, username, password));
    perHost.push({ host, provider, status: 'ok', detail: '' });

    // Tell the host credential helper to persist the credential we
    // just received. `git credential fill` itself never triggers a
    // helper `store` — git only does that automatically after using
    // a credential successfully on a real remote operation. Without
    // this explicit approve, an OAuth flow that GCM kicked off on
    // first apply returns the token to us, but GCM never writes it
    // to the Windows Credential Manager. Result: every subsequent
    // apply pops a fresh browser auth dialog. Best-effort — non-zero
    // from approve is non-fatal; we still wrote the in-container
    // credentials file, which is what apply actually relies on.
    const approveInput = `protocol=https\nhost=${host}\nusername=${username}\npassword=${password}\n\n`;
    try {
      await approveFn(approveInput);
    } catch {
      /* best-effort, don't block apply on credential-store hiccups */
    }
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
    hostsSkipped: perHost.filter((p) => p.status !== 'ok').length,
    perHost,
    credentialsPath,
  };
}

/**
 * Expose `uniqueHttpsHosts` for callers that need the host list
 * directly (apply uses it to build the pre-flight check input).
 */
export { uniqueHttpsHosts };

/**
 * Build the multi-host pre-flight error message that gets thrown when
 * apply discovers missing credentials. Header inlines the provider
 * for single-host cases; body is left-aligned setup instructions.
 *
 * Format:
 *
 *   Missing Git credentials: <host> — <Provider>
 *
 *   <setup instructions, left-aligned, multi-line>
 *
 *   Then re-run `monoceros apply`.
 *
 * For multi-host failures, each block is separated by a blank line
 * and gets its own provider title.
 */
export function formatMissingCredentialsError(
  missing: readonly HostCredentialStatus[],
): string {
  if (missing.length === 1) {
    const m = missing[0]!;
    const hint = providerSetupHint(m.host, m.provider);
    return [
      `Missing Git credentials: ${hint.title}`,
      '',
      hint.body,
      '',
      `Then re-run ${cyan('monoceros apply')}.`,
    ].join('\n');
  }
  const lines: string[] = [
    `Missing Git credentials for ${missing.length} hosts:`,
    '',
  ];
  for (const m of missing) {
    const hint = providerSetupHint(m.host, m.provider);
    lines.push(hint.title);
    lines.push('');
    lines.push(hint.body);
    lines.push('');
  }
  lines.push(`Then re-run ${cyan('monoceros apply')}.`);
  return lines.join('\n');
}

/**
 * Build the pre-flight error for repos whose host has no provider
 * declared and isn't one of the canonical ones (github.com /
 * gitlab.com / bitbucket.org). The builder needs to add a
 * `provider:` field to the yml before apply can continue.
 */
export function formatUnknownProviderError(hosts: readonly string[]): string {
  const sorted = [...new Set(hosts)].sort();
  const lines: string[] = [
    sorted.length === 1
      ? `Unknown Git provider for host ${sorted[0]!}.`
      : `Unknown Git provider for ${sorted.length} hosts: ${sorted.join(', ')}.`,
    '',
    'Monoceros auto-detects only github.com / gitlab.com / bitbucket.org.',
    'For any other host (self-hosted GitLab, Gitea, Bitbucket Server, …)',
    'declare the provider explicitly in the yml. Edit the repo entry:',
    '',
    cyan('  repos:'),
    cyan(`    - url: https://${sorted[0]!}/…`),
    cyan('      provider: gitlab   # or: github, bitbucket, gitea'),
    '',
    `Or re-add with ${cyan('monoceros add-repo <name> <url> --provider=<github|gitlab|bitbucket|gitea>')}.`,
  ];
  return lines.join('\n');
}

// Exported for tests.
export const _internals = {
  uniqueHttpsHosts,
  parseCredentialFillOutput,
  formatCredentialLine,
};
