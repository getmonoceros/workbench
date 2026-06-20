import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * SSH attach point setup for the dev container (ADR 0022).
 *
 * The runtime image runs sshd on loopback; the host reaches it portless
 * through `docker exec … socat … TCP:127.0.0.1:22`. This module is the
 * host-side half: it mints a per-container keypair, drops a small proxy
 * script that resolves the running container by the
 * `devcontainer.local_folder` label (the same handle `monoceros shell`
 * uses, so it follows rebuilds), and registers an OpenSSH `Host
 * monoceros-<name>` block so any SSH-capable IDE (Codium, IntelliJ, Zed)
 * or a plain `ssh monoceros-<name>` attaches with zero config.
 *
 * The container never depends on the builder owning a host SSH key - we
 * always mint our own, scoped to this one container. "No key present" is
 * therefore not an error path.
 */

/** Injectable `ssh-keygen` runner. Tests stub this. */
export type KeygenSpawn = (
  args: readonly string[],
) => Promise<{ exitCode: number; stderr: string }>;

const realKeygen: KeygenSpawn = (args) => {
  return new Promise((resolve, reject) => {
    const child = spawn('ssh-keygen', args as string[], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ exitCode: code ?? 0, stderr }));
  });
};

export interface SetupSshAttachOptions {
  /** Container name (`monoceros-<name>` becomes the SSH host alias). */
  name: string;
  /**
   * Materialized container directory - this is BOTH where the keypair
   * lives (`<targetDir>/.monoceros/ssh/`) and the value of the
   * `devcontainer.local_folder` label the proxy script filters on.
   */
  targetDir: string;
  /** MONOCEROS_HOME - holds `ssh/config.d/<name>` and `ssh/exec-<name>.sh`. */
  home: string;
  /** User SSH dir holding `config`. Defaults to `~/.ssh`; tests override. */
  userSshDir?: string;
  keygen?: KeygenSpawn;
  logger?: { info: (m: string) => void; warn: (m: string) => void };
  /**
   * Host-loopback port for the Windows direct-port attach (ADR 0022
   * revision), set only when the pinned runtime publishes it (>= 1.3.5). When
   * given, the Windows `Host` block is a direct `HostName`/`Port`; otherwise
   * it keeps the portless docker-exec ProxyCommand (works for system OpenSSH /
   * IDEs on older runtimes). Ignored off WSL.
   */
  windowsDirectPort?: number | null;
  /**
   * Windows/WSL bridge injectables. Omitted in production (real WSL
   * detection + cmd.exe/wslpath/icacls); tests stub them to write into a
   * temp dir without a real WSL. See the Windows bridge section.
   */
  windows?: WindowsBridgeDeps;
}

export interface SetupSshAttachResult {
  /** The OpenSSH host alias (`monoceros-<name>`). */
  hostAlias: string;
  /** False when setup was skipped (e.g. `ssh-keygen` unavailable). */
  configured: boolean;
}

/** `~/.ssh`-relative locations Monoceros owns under MONOCEROS_HOME. */
export function sshHomeDir(home: string): string {
  return path.join(home, 'ssh');
}

export function sshConfigEntryPath(home: string, name: string): string {
  return path.join(sshHomeDir(home), 'config.d', name);
}

export function sshProxyScriptPath(home: string, name: string): string {
  return path.join(sshHomeDir(home), `exec-${name}.sh`);
}

function privateKeyPath(targetDir: string): string {
  return path.join(targetDir, '.monoceros', 'ssh', 'id_ed25519');
}

/**
 * Mint a per-container ed25519 keypair if absent (idempotent: an
 * existing keypair is reused so the host alias stays stable across
 * applies). Returns the private/public key paths, or `null` when
 * `ssh-keygen` isn't runnable - the caller degrades gracefully.
 */
async function ensureKeypair(
  targetDir: string,
  name: string,
  keygen: KeygenSpawn,
  logger: { warn: (m: string) => void },
): Promise<{ privateKey: string; publicKey: string } | null> {
  const privateKey = privateKeyPath(targetDir);
  const publicKey = `${privateKey}.pub`;
  if (existsSync(privateKey) && existsSync(publicKey)) {
    return { privateKey, publicKey };
  }
  await fs.mkdir(path.dirname(privateKey), { recursive: true });
  try {
    const res = await keygen([
      '-t',
      'ed25519',
      '-N',
      '',
      '-f',
      privateKey,
      '-C',
      `monoceros-${name}`,
      '-q',
    ]);
    if (res.exitCode !== 0) {
      logger.warn(
        `ssh-keygen failed (exit ${res.exitCode})${res.stderr ? `: ${res.stderr.trim()}` : ''}; IDE SSH attach not set up.`,
      );
      return null;
    }
  } catch (err) {
    logger.warn(
      `ssh-keygen not runnable (${err instanceof Error ? err.message : String(err)}); IDE SSH attach not set up.`,
    );
    return null;
  }
  return { privateKey, publicKey };
}

function proxyScriptContent(name: string, targetDir: string): string {
  return `#!/bin/sh
# Generated by Monoceros (ADR 0022) - do not edit.
# Portless SSH transport into the running dev container '${name}'.
# Resolves the container by the devcontainer.local_folder label (the
# same handle 'monoceros shell' uses), so it follows rebuilds.
set -e
# GUI launchers (IDEs, Claude Desktop) start a ProxyCommand with a
# minimal PATH: on macOS launchd hands out only /usr/bin:/bin:/usr/sbin:
# /sbin, so a bare \`docker\` (Docker Desktop installs it under
# /usr/local/bin or /opt/homebrew/bin) isn't found. Prepend the common
# Docker locations so the same script works from a login shell and a GUI
# launcher alike.
PATH="/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin:$PATH"
cid=$(docker ps -q \\
  --filter "label=devcontainer.local_folder=${targetDir}" \\
  --filter status=running | head -n1)
if [ -z "$cid" ]; then
  echo "monoceros: dev container '${name}' is not running. Start it with: monoceros apply ${name}" >&2
  exit 1
fi
exec docker exec -i "$cid" socat - TCP:127.0.0.1:22
`;
}

function configEntryContent(
  name: string,
  hostAlias: string,
  privateKey: string,
  proxyScript: string,
  directPort: number | null,
): string {
  // Quote the path-valued options so spaces in MONOCEROS_HOME don't
  // break parsing. Host keys are ephemeral (regenerated per container in
  // the entrypoint), so host-key checking is disabled - there is no
  // persistent identity to pin and it would only nag across rebuilds.
  const head = `# Generated by Monoceros (ADR 0022) - do not edit.
# Attach an SSH-capable IDE (Codium, IntelliJ, Zed) to host
# '${hostAlias}', or run: ssh ${hostAlias}
Host ${hostAlias}`;
  const common = `    User node
    IdentityFile "${privateKey}"
    IdentitiesOnly yes
    StrictHostKeyChecking no
    UserKnownHostsFile /dev/null`;
  // On WSL (directPort set) the connection is a DIRECT host-loopback port,
  // not the docker-exec ProxyCommand: this same config is read by IDEs and by
  // the Claude desktop app's ssh2, which cannot run a ProxyCommand on Windows
  // (it spawns it via `sh`). `apply` publishes the port; sshd-up.sh forwards
  // it. Native Linux/macOS keep the portless ProxyCommand transport.
  if (directPort !== null) {
    return `${head}
    HostName 127.0.0.1
    Port ${directPort}
${common}
`;
  }
  return `${head}
${common}
    ProxyCommand "${proxyScript}"
`;
}

/**
 * Idempotently prepend `Include <home>/ssh/config.d/*` to the user's
 * `~/.ssh/config` so every container's generated entry is picked up.
 * Additive and clearly marked - existing entries are never rewritten.
 */
async function ensureInclude(userSshDir: string, home: string): Promise<void> {
  const configPath = path.join(userSshDir, 'config');
  const includeTarget = path.join(sshHomeDir(home), 'config.d', '*');
  const includeLine = `Include "${includeTarget}"`;

  await fs.mkdir(userSshDir, { recursive: true });
  let existing = '';
  try {
    existing = await fs.readFile(configPath, 'utf8');
  } catch {
    existing = '';
  }
  // Match the exact include target regardless of surrounding quotes.
  if (existing.includes(includeTarget)) return;

  const banner =
    '# Added by Monoceros (ADR 0022): per-container SSH attach entries.';
  const prefix = `${banner}\n${includeLine}\n`;
  const next = existing.length > 0 ? `${prefix}\n${existing}` : prefix;
  await fs.writeFile(configPath, next, { mode: 0o600 });
  await fs.chmod(configPath, 0o600).catch(() => {});
}

// ─── Windows/WSL bridge (ADR 0022) ────────────────────────────────
// On Windows the CLI runs in WSL, but the editor (Codium / VS Code /
// JetBrains Gateway) runs on Windows and reads the Windows-side
// `C:\Users\<user>\.ssh\config` - it never sees the WSL-side entry. So
// when running under WSL we ALSO write the connection on the Windows
// side: a per-container key in our own `.ssh\monoceros\` subdir (no
// collision with the user's keys) and a marked Host block in the
// Windows `~/.ssh/config` (found + replaced surgically, the rest of the
// user's config untouched). The `docker exec … socat` transport is
// host-agnostic (docker.exe reaches the same daemon), and the
// deterministic container name means no wrapper script is needed.

export interface WindowsProfile {
  /** WSL path to the Windows home, e.g. `/mnt/c/Users/X`. */
  homeWsl: string;
  /** Windows path to the Windows home, e.g. `C:\Users\X`. */
  homeWin: string;
  /** Windows username, for the icacls grant. */
  user: string;
}

/** Injectable bits of the Windows bridge. Tests stub all three. */
export interface WindowsBridgeDeps {
  isWsl?: () => boolean;
  resolveProfile?: () => Promise<WindowsProfile | null>;
  lockKey?: (winKeyPath: string, user: string) => Promise<void>;
}

function runCapture(
  cmd: string,
  args: readonly string[],
): Promise<{ stdout: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args as string[], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let stdout = '';
    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString();
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ stdout, exitCode: code ?? 0 }));
  });
}

export function isWsl(): boolean {
  try {
    if (process.env.WSL_DISTRO_NAME) return true;
    const rel = readFileSync(
      '/proc/sys/kernel/osrelease',
      'utf8',
    ).toLowerCase();
    return rel.includes('microsoft') || rel.includes('wsl');
  } catch {
    return false;
  }
}

// USERPROFILE via cmd.exe (no extra package; verified on a real box),
// then wslpath for the /mnt/c view. The Windows username is the last
// segment of `C:\Users\X`.
export async function resolveWindowsProfile(): Promise<WindowsProfile | null> {
  try {
    const r = await runCapture('cmd.exe', ['/c', 'echo %USERPROFILE%']);
    const homeWin = r.stdout.replace(/\r/g, '').trim();
    if (r.exitCode !== 0 || !homeWin || homeWin.includes('%USERPROFILE%')) {
      return null;
    }
    const w = await runCapture('wslpath', ['-u', homeWin]);
    const homeWsl = w.stdout.trim();
    const user = homeWin.split('\\').pop() ?? '';
    if (w.exitCode !== 0 || !homeWsl || !user) return null;
    return { homeWsl, homeWin, user };
  } catch {
    return null;
  }
}

async function realLockWindowsKey(
  winKeyPath: string,
  user: string,
): Promise<void> {
  // OpenSSH-Windows rejects keys whose ACLs are too open. Strip
  // inheritance and grant read to the owner only.
  await runCapture('icacls.exe', [
    winKeyPath,
    '/inheritance:r',
    '/grant:r',
    `${user}:R`,
  ]);
}

function resolveWindowsDeps(
  d?: WindowsBridgeDeps,
): Required<WindowsBridgeDeps> {
  return {
    isWsl: d?.isWsl ?? isWsl,
    resolveProfile: d?.resolveProfile ?? resolveWindowsProfile,
    lockKey: d?.lockKey ?? realLockWindowsKey,
  };
}

/**
 * Deterministic host-loopback port for the Windows ssh bridge of a container.
 * Picked from the IANA dynamic/private range (49152-65535) by hashing the
 * name, so it's stable across applies and unlikely to collide with a dev
 * server. The same value is published by the scaffold and forwarded to sshd
 * by `sshd-up.sh`.
 */
export function windowsSshPort(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) >>> 0;
  }
  return 49152 + (h % 16384);
}

function windowsHostBlock(
  hostAlias: string,
  keyWin: string,
  port: number | null,
): string {
  const head = [
    `Host ${hostAlias}`,
    `    User node`,
    `    IdentityFile ${keyWin}`,
    `    IdentitiesOnly yes`,
    `    StrictHostKeyChecking no`,
    `    UserKnownHostsFile NUL`,
  ];
  if (port !== null) {
    // Runtime >= 1.3.5: connect DIRECTLY to the host-loopback port `apply`
    // publishes (sshd-up.sh forwards it to the in-container sshd). The Claude
    // desktop app's bundled ssh2 cannot run a ProxyCommand on Windows (it
    // spawns it via `sh`, absent there); it ignores `UserKnownHostsFile` and
    // uses ~/.ssh/known_hosts, which `apply` populates with the host key.
    return [
      `Host ${hostAlias}`,
      `    HostName 127.0.0.1`,
      `    Port ${port}`,
      ...head.slice(1),
    ].join('\n');
  }
  // Older runtime: no published port, so keep the portless docker-exec
  // ProxyCommand. System OpenSSH (terminal, VS Code/Codium/JetBrains) runs it
  // fine on Windows; the Claude app can't (no `sh`) until the container is on
  // a runtime that publishes the port.
  return [
    ...head,
    `    ProxyCommand docker exec -i ${hostAlias} socat - TCP:127.0.0.1:22`,
  ].join('\n');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function blockMarkers(hostAlias: string): { begin: string; end: string } {
  return {
    begin: `# >>> monoceros ${hostAlias} >>>`,
    end: `# <<< monoceros ${hostAlias} <<<`,
  };
}

// Surgically upsert OUR marked block in the user's Windows ssh config.
// We only ever touch the region between our markers; everything the
// builder wrote stays put.
async function upsertMarkedBlock(
  configPath: string,
  hostAlias: string,
  body: string,
): Promise<void> {
  const { begin, end } = blockMarkers(hostAlias);
  const section = `${begin}\n${body}\n${end}`;
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  let existing = '';
  try {
    existing = await fs.readFile(configPath, 'utf8');
  } catch {
    existing = '';
  }
  const re = new RegExp(`${escapeRegExp(begin)}[\\s\\S]*?${escapeRegExp(end)}`);
  if (re.test(existing)) {
    await fs.writeFile(configPath, existing.replace(re, section));
    return;
  }
  const sep = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
  await fs.writeFile(configPath, `${existing}${sep}${section}\n`);
}

async function removeMarkedBlock(
  configPath: string,
  hostAlias: string,
): Promise<void> {
  let existing = '';
  try {
    existing = await fs.readFile(configPath, 'utf8');
  } catch {
    return;
  }
  const { begin, end } = blockMarkers(hostAlias);
  const re = new RegExp(
    `\\n?${escapeRegExp(begin)}[\\s\\S]*?${escapeRegExp(end)}\\n?`,
    'g',
  );
  await fs.writeFile(
    configPath,
    existing.replace(re, '\n').replace(/\n{3,}/g, '\n\n'),
  );
}

async function setupWindowsBridge(
  name: string,
  hostAlias: string,
  privateKey: string,
  directPort: number | null,
  deps: Required<WindowsBridgeDeps>,
  logger: { info: (m: string) => void; warn: (m: string) => void },
): Promise<void> {
  if (!deps.isWsl()) return;
  const profile = await deps.resolveProfile();
  if (!profile) {
    logger.warn(
      'WSL detected but the Windows user profile could not be resolved; skipping the Windows SSH bridge.',
    );
    return;
  }
  const monoDir = path.join(profile.homeWsl, '.ssh', 'monoceros');
  await fs.mkdir(monoDir, { recursive: true });
  // Key in our own subdir so it can never clobber a user key in `.ssh\`.
  // A previous apply locked this file read-only (icacls below), so
  // copying straight over it would fail with EACCES. Remove it first;
  // the per-container key is stable, so this just refreshes an identical
  // file with fresh (inherited) ACLs before we re-lock it.
  const keyDst = path.join(monoDir, name);
  await fs.rm(keyDst, { force: true });
  await fs.copyFile(privateKey, keyDst);
  const keyWin = `${profile.homeWin}\\.ssh\\monoceros\\${name}`;
  await upsertMarkedBlock(
    path.join(profile.homeWsl, '.ssh', 'config'),
    hostAlias,
    windowsHostBlock(hostAlias, keyWin, directPort),
  );
  await deps.lockKey(keyWin, profile.user);
  logger.info(
    `Windows SSH bridge ready: \`ssh ${hostAlias}\` (Codium/Gateway too).`,
  );
}

async function removeWindowsBridge(
  name: string,
  hostAlias: string,
  deps: Required<WindowsBridgeDeps>,
): Promise<void> {
  if (!deps.isWsl()) return;
  const profile = await deps.resolveProfile();
  if (!profile) return;
  await fs.rm(path.join(profile.homeWsl, '.ssh', 'monoceros', name), {
    force: true,
  });
  await removeMarkedBlock(
    path.join(profile.homeWsl, '.ssh', 'config'),
    hostAlias,
  );
}

export async function setupSshAttach(
  opts: SetupSshAttachOptions,
): Promise<SetupSshAttachResult> {
  const hostAlias = `monoceros-${opts.name}`;
  const logger = opts.logger ?? { info: () => {}, warn: () => {} };
  const keygen = opts.keygen ?? realKeygen;
  const userSshDir = opts.userSshDir ?? path.join(os.homedir(), '.ssh');

  const keys = await ensureKeypair(opts.targetDir, opts.name, keygen, logger);
  if (!keys) return { hostAlias, configured: false };

  const proxyScript = sshProxyScriptPath(opts.home, opts.name);
  const configEntry = sshConfigEntryPath(opts.home, opts.name);

  // The direct-port form applies ONLY on WSL, where `apply` publishes the
  // port and sshd-up.sh forwards it. On native Linux/macOS there is no
  // published port, so this config (and the Windows bridge) keep the portless
  // ProxyCommand. The Claude desktop app reads THIS unix config on WSL (via
  // the `Include`), so the block must be direct there - its ssh2 can't run a
  // ProxyCommand on Windows.
  const winDeps = resolveWindowsDeps(opts.windows);
  const directPort = winDeps.isWsl() ? (opts.windowsDirectPort ?? null) : null;

  await fs.mkdir(path.dirname(proxyScript), { recursive: true });
  await fs.mkdir(path.dirname(configEntry), { recursive: true });

  await fs.writeFile(
    proxyScript,
    proxyScriptContent(opts.name, opts.targetDir),
    { mode: 0o755 },
  );
  await fs.chmod(proxyScript, 0o755).catch(() => {});
  await fs.writeFile(
    configEntry,
    configEntryContent(
      opts.name,
      hostAlias,
      keys.privateKey,
      proxyScript,
      directPort,
    ),
  );

  await ensureInclude(userSshDir, opts.home);

  // On WSL, also write the Windows-side bridge so a Windows editor can
  // attach. No-op on macOS / native Linux. Non-fatal.
  try {
    await setupWindowsBridge(
      opts.name,
      hostAlias,
      keys.privateKey,
      directPort,
      winDeps,
      logger,
    );
  } catch (err) {
    logger.warn(
      `Windows SSH bridge skipped: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return { hostAlias, configured: true };
}

/** Replace (or append) the single `known_hosts` line for `hostId`. */
async function upsertKnownHost(
  knownHostsPath: string,
  hostId: string,
  typeAndKey: string,
): Promise<void> {
  await fs.mkdir(path.dirname(knownHostsPath), { recursive: true });
  let existing = '';
  try {
    existing = await fs.readFile(knownHostsPath, 'utf8');
  } catch {
    existing = '';
  }
  // Drop any prior line for this exact host id (our own, or a stale one from
  // an earlier ephemeral key), keep everything else, then append the current.
  const kept = existing
    .split('\n')
    .filter((l) => l.trim().length > 0 && l.split(/\s+/)[0] !== hostId);
  const next = `${[...kept, `${hostId} ${typeAndKey}`].join('\n')}\n`;
  await fs.writeFile(knownHostsPath, next);
}

/**
 * Record the container's (now stable, ADR 0022 revision) SSH host key in
 * `~/.ssh/known_hosts` so the Claude desktop app's `ssh2` - which does no
 * trust-on-first-use - accepts the host. Reads the public host key persisted
 * by `sshd-up.sh` under the container dir. Runs AFTER the container is up (the
 * key is generated on first start). Best-effort: a missing key (older runtime)
 * is a silent no-op. System OpenSSH ignores this (it disables host-key
 * checking), so this only affects the app.
 *
 *  - macOS/Linux: keyed by the alias `monoceros-<name>` (ProxyCommand path).
 *  - Windows (WSL): also written to the Windows `~/.ssh/known_hosts`, keyed by
 *    `[127.0.0.1]:<port>` (the direct-port path).
 */
export async function recordHostKey(opts: {
  name: string;
  targetDir: string;
  userSshDir?: string;
  windows?: WindowsBridgeDeps;
}): Promise<void> {
  const pubPath = path.join(
    opts.targetDir,
    '.monoceros',
    'ssh',
    'host',
    'ssh_host_ed25519_key.pub',
  );
  let line = '';
  try {
    line = (await fs.readFile(pubPath, 'utf8')).trim();
  } catch {
    return; // no persisted host key (older runtime / not up yet) - skip
  }
  const parts = line.split(/\s+/);
  if (parts.length < 2) return;
  const typeAndKey = `${parts[0]} ${parts[1]}`;

  const userSshDir = opts.userSshDir ?? path.join(os.homedir(), '.ssh');
  await upsertKnownHost(
    path.join(userSshDir, 'known_hosts'),
    `monoceros-${opts.name}`,
    typeAndKey,
  );

  const deps = resolveWindowsDeps(opts.windows);
  if (deps.isWsl()) {
    const profile = await deps.resolveProfile();
    if (profile) {
      await upsertKnownHost(
        path.join(profile.homeWsl, '.ssh', 'known_hosts'),
        `[127.0.0.1]:${windowsSshPort(opts.name)}`,
        typeAndKey,
      );
    }
  }
}

/**
 * Tear down the host-side SSH attach artifacts for a container
 * (`monoceros remove`). The keypair lives under the container dir, which
 * `remove` deletes wholesale; this clears the MONOCEROS_HOME-side proxy
 * script and config.d entry. The `Include` line in `~/.ssh/config` is
 * left in place - it harmlessly globs an empty/!existent dir and other
 * containers still rely on it.
 */
export async function removeSshAttach(
  home: string,
  name: string,
  windows?: WindowsBridgeDeps,
): Promise<void> {
  await fs.rm(sshProxyScriptPath(home, name), { force: true });
  await fs.rm(sshConfigEntryPath(home, name), { force: true });
  // Tear down the Windows-side bridge too (WSL only). No-op elsewhere.
  try {
    await removeWindowsBridge(
      name,
      `monoceros-${name}`,
      resolveWindowsDeps(windows),
    );
  } catch {
    // best-effort; a stale Windows entry is harmless
  }
}
