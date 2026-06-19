import { spawn } from 'node:child_process';
import {
  readMachineStateSync,
  recordVersionCheck,
  type MachineState,
} from '../config/machine-state.js';

// Self-update notice. On every (interactive) command we read a cached
// "latest version" from machine-state — NO network on the hot path — and,
// if it's newer than the running CLI, print a one-line notice at exit. When
// the cache is stale we spawn a DETACHED background process (`monoceros
// __update-check`) that refreshes it from npm for next time, so the current
// command pays zero latency. Failures are always silent: a version check
// never breaks a command.

/** The published package whose latest version we compare against. */
const PACKAGE = '@getmonoceros/workbench';
/** npm registry endpoint for the `latest` dist-tag manifest. */
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE}/latest`;
/**
 * The ONE install/update command, all platforms (on Windows it runs inside
 * WSL — there is no `.ps1`). Matches README. npm is an implementation
 * detail INSIDE the script and is never surfaced as an alternative.
 */
const INSTALL_COMMAND =
  'curl -fsSL https://raw.githubusercontent.com/getmonoceros/workbench/main/install.sh | bash';
/** Check at most this often. */
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Set to any non-empty value to silence the check entirely. */
const OPT_OUT_ENV = 'MONOCEROS_NO_UPDATE_NOTIFIER';
/** Network timeout for the background fetch. */
const FETCH_TIMEOUT_MS = 5000;

/** Commands the notice must never piggyback on (machine-readable / internal). */
const SKIP_COMMANDS = new Set(['__complete', '__update-check', 'completion']);

/**
 * Numeric `x.y.z` "is `latest` strictly newer than `current`?". Prerelease /
 * build suffixes are ignored; anything non-semver (e.g. the dev build's
 * `dev`) is treated as not-newer, so a dev CLI never nags.
 */
export function isNewerVersion(latest: string, current: string): boolean {
  const parse = (v: string): [number, number, number] | null => {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const a = parse(latest);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i]! > b[i]!;
  }
  return false;
}

/** The notice text (trailing + leading newline so it stands apart). */
export function formatUpdateNotice(latest: string, current: string): string {
  return (
    `\n⬆ Monoceros ${latest} is available (you have ${current}).\n` +
    `  Update:  ${INSTALL_COMMAND}\n`
  );
}

/**
 * Pure decision from the cached state: what notice (if any) to print, and
 * whether the cache is stale enough to refresh. No I/O — the testable core.
 */
export function decideUpdateAction(
  state: Pick<MachineState, 'latestVersion' | 'lastVersionCheckAt'>,
  currentVersion: string,
  now: Date,
  intervalMs: number = CHECK_INTERVAL_MS,
): { notice: string | null; refresh: boolean } {
  const notice =
    state.latestVersion && isNewerVersion(state.latestVersion, currentVersion)
      ? formatUpdateNotice(state.latestVersion, currentVersion)
      : null;
  const last = state.lastVersionCheckAt
    ? new Date(state.lastVersionCheckAt).getTime()
    : NaN;
  const refresh = !Number.isFinite(last) || now.getTime() - last > intervalMs;
  return { notice, refresh };
}

/**
 * Schedule the update notice for this invocation: read the cached state,
 * register an exit-time print if a newer version is known, and kick off a
 * detached background refresh when the cache is stale. Returns immediately
 * and never throws. Caller passes the running version + the resolved
 * sub-command name.
 */
export function scheduleUpdateNotice(opts: {
  currentVersion: string;
  commandName: string | undefined;
  argv?: readonly string[];
  now?: Date;
}): void {
  try {
    if (process.env[OPT_OUT_ENV]) return;
    if (opts.currentVersion === 'dev') return; // unbuilt / local checkout
    if (!process.stdout.isTTY) return; // CI / pipes — stay quiet
    if (opts.commandName === undefined) return; // bare `monoceros`
    if (SKIP_COMMANDS.has(opts.commandName)) return;
    const argv = opts.argv ?? process.argv.slice(2);
    if (argv.some((a) => ['-h', '--help', '-v', '--version'].includes(a))) {
      return; // the builder asked for info, not to run a command
    }

    const state = readMachineStateSync();
    const { notice, refresh } = decideUpdateAction(
      state,
      opts.currentVersion,
      opts.now ?? new Date(),
    );
    if (notice) {
      process.on('exit', () => {
        try {
          process.stderr.write(notice);
        } catch {
          /* exiting — best effort */
        }
      });
    }
    if (refresh) spawnBackgroundCheck();
  } catch {
    /* a version check never breaks a command */
  }
}

/** Fire-and-forget `monoceros __update-check` (detached, output discarded). */
function spawnBackgroundCheck(): void {
  const self = process.argv[1];
  if (!self) return;
  try {
    const child = spawn(process.execPath, [self, '__update-check'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch {
    /* best effort */
  }
}

/**
 * The background worker (run by the hidden `__update-check` command): fetch
 * the latest version from npm and cache it. Always stamps the check time so
 * a transient failure backs off the interval instead of re-spawning on every
 * command. Silent on every error.
 */
export async function runUpdateCheck(
  now: Date = new Date(),
  home?: string,
): Promise<void> {
  let latestVersion: string | undefined;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(REGISTRY_URL, { signal: controller.signal });
      if (res.ok) {
        const json = (await res.json()) as { version?: unknown };
        if (typeof json.version === 'string') latestVersion = json.version;
      }
    } finally {
      clearTimeout(timer);
    }
  } catch {
    /* offline / timeout / parse — fall through, just stamp the time */
  }
  try {
    await recordVersionCheck(
      {
        ...(latestVersion ? { latestVersion } : {}),
        nowIso: now.toISOString(),
      },
      home,
    );
  } catch {
    /* best effort */
  }
}
