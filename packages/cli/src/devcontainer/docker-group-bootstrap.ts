import { spawnSync } from 'node:child_process';
import { userInfo } from 'node:os';

/**
 * Transparent recovery for the "Linux + fresh usermod + same desktop
 * session" trap.
 *
 * After `sudo usermod -aG docker $USER`, the user IS in /etc/group's
 * docker line — but the running desktop session loaded its group list
 * at GNOME/KDE login time and has no way to refresh. Every shell
 * spawned from that session inherits the stale list, so `docker info`
 * fails with "permission denied while connecting to docker.sock"
 * until the user either runs `newgrp docker` (per-shell), opens a
 * fresh login session (`su -l`, `ssh localhost`), or logs out of the
 * desktop entirely.
 *
 * That ceremony is real, well-known, and intentional (Linux process
 * credentials can't be live-updated for security reasons). But making
 * the *user* deal with it for every `monoceros …` invocation in a
 * fresh terminal tab is bad UX.
 *
 * This helper sidesteps it for monoceros's own process tree:
 *
 *   1. Probe `docker info`. If it works, no-op — we're good.
 *   2. If it fails AND the user is in /etc/group's docker line
 *      (= `usermod` already ran successfully), re-exec ourselves
 *      via `sg docker -c "node …"`. `sg` is the shadow-utils helper
 *      that runs a single command under a different primary group;
 *      it reads /etc/group fresh so the docker membership applies.
 *   3. If the user is NOT in /etc/group's docker line, return — the
 *      caller will hit the docker failure on its own and surface a
 *      "run usermod" error that's actually actionable.
 *
 * The re-exec is invisible to the user: bash sees a single
 * `monoceros …` command, history captures one line, ↑ arrow returns
 * the exact command. The sg sub-process lives only as long as
 * monoceros's own run, then exits.
 *
 * Linux-only. macOS / Windows Docker Desktop use different access
 * mechanisms (CLI-helper, named pipes) where group membership
 * doesn't apply — we early-return.
 */

const REEXEC_MARKER = 'MONOCEROS_DOCKER_GROUP_REEXEC';

/**
 * Probes docker access and, if needed, transparently re-execs the
 * current node process under the docker group via `sg docker`. Never
 * returns if a re-exec fired (calls `process.exit` with the sg
 * sub-process's exit code).
 *
 * Returns when no recovery was needed or possible. The caller should
 * proceed with normal execution; downstream docker calls will either
 * work (recovery succeeded) or fail with the original permission
 * error (recovery wasn't applicable — typically usermod wasn't run).
 */
export function bootstrapDockerGroup(
  opts: {
    /** Override spawn behavior — tests inject deterministic responses. */
    runProbe?: (cmd: string, args: readonly string[]) => number;
    /** Tests inject the re-exec without actually fork+exec'ing. */
    reexec?: (argv: readonly string[]) => number;
    /** Override $USER detection. Tests inject a stable value. */
    username?: string;
    /** Override process.platform. Tests inject 'linux'. */
    platform?: NodeJS.Platform;
    /** Override env-marker check. Tests inject either undefined or '1'. */
    marker?: string;
  } = {},
): void {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'linux') return;

  const marker = opts.marker ?? process.env[REEXEC_MARKER];
  if (marker === '1') return; // already re-exec'd, don't loop

  const probe = opts.runProbe ?? defaultProbe;

  // `docker --version` doesn't touch the daemon — it's a client-only
  // call. If it fails, docker isn't installed at all. The downstream
  // error path will tell the user to install docker; we have nothing
  // to recover from.
  if (probe('docker', ['--version']) !== 0) return;

  // `docker info` does talk to the daemon. exit 0 = access works,
  // non-zero = either daemon down or permission denied. Either way
  // we have nothing to gain by trying sg — re-exec'ing under docker
  // group won't fix a stopped daemon.
  if (probe('docker', ['info']) === 0) return;

  // Daemon unreachable. Is this the "usermod already ran" case?
  const username = opts.username ?? userInfo().username;
  if (!isInDockerGroupViaEtcGroup(username, probe)) return;

  // Re-exec via sg. Use the exact argv that started us so the new
  // process is indistinguishable from the original invocation.
  const reexec = opts.reexec ?? defaultReexec;
  const exitCode = reexec(process.argv);
  process.exit(exitCode);
}

/**
 * Read /etc/group via getent and check whether `username` appears in
 * the docker line's member list. We use `getent` rather than parsing
 * /etc/group directly so NSS-backed group sources (LDAP, sssd, …)
 * are honored too. Returns false on any failure — the caller treats
 * "we couldn't confirm membership" the same as "not a member", which
 * is the safe default (no re-exec attempt → original error surfaces).
 */
function isInDockerGroupViaEtcGroup(
  username: string,
  probe: (cmd: string, args: readonly string[]) => number,
): boolean {
  // We need stdout, not just exit code, so the probe interface
  // doesn't suffice. Run getent directly.
  const result = spawnSync('getent', ['group', 'docker'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  void probe; // signature parity with the rest of the helper
  if (result.status !== 0) return false;
  // getent output: `docker:x:984:user1,user2,parallels`
  // We want the comma-separated member list after the third colon.
  const fields = result.stdout.split(':');
  if (fields.length < 4) return false;
  const members = (fields[3] ?? '')
    .trim()
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
  return members.includes(username);
}

function defaultProbe(cmd: string, args: readonly string[]): number {
  const result = spawnSync(cmd, [...args], { stdio: 'ignore' });
  return result.status ?? 1;
}

function defaultReexec(argv: readonly string[]): number {
  // argv[0] is the node binary, argv[1] is our bin.ts entry, argv[2+]
  // are the user-supplied flags/positionals. `sg docker -c "…"` needs
  // a single shell-quoted command string.
  const quoted = argv.map(shellQuote).join(' ');
  const env = { ...process.env, [REEXEC_MARKER]: '1' };
  const result = spawnSync('sg', ['docker', '-c', quoted], {
    stdio: 'inherit',
    env,
  });
  return result.status ?? 1;
}

/**
 * Single-quote-wrap an argv element so it survives `sg docker -c "…"`.
 * The wrapping pattern `'a'\''b'` is the standard "literal single
 * quotes inside a single-quoted string" trick — close the quote,
 * escape a literal quote, reopen.
 */
function shellQuote(arg: string): string {
  // Safe characters that don't need quoting at all.
  if (/^[\w./@:=,+-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

// Exported for tests.
export const _internals = { isInDockerGroupViaEtcGroup, shellQuote };
