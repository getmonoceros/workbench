# ADR 0011 — WSL-only on Windows

- Status: accepted
- Date: 2026-06-01

## Context

Up to 1.11, Monoceros had two install paths on Windows:

1. **Windows host** — `install.ps1` ran in PowerShell, installed
   Monoceros as a Windows-native Node CLI via npm, and wrote state to
   `%USERPROFILE%\.monoceros`.
2. **WSL** — `install.sh` from within a WSL distro; Monoceros ran as a
   regular Linux tool, with state under `~/.monoceros` in the distro
   and Docker via Docker Desktop's WSL integration.

The dual-path approach was meant as a convenience: Windows users who
don't live in WSL should be able to use Monoceros directly from
PowerShell. In practice, though, Windows-host-specific friction points
accumulated, each of which had to be solved individually:

- **Drive-letter case** in Docker labels: devcontainer-cli lowercases
  the drive letter (`c:\…`), `path.join` on Windows returns it
  uppercase (`C:\…`), and Docker filters are byte-exact → containers
  were left behind as zombies on `remove`.
- **cmd.exe quoting**: shell scripts (for cleanup pipelines) ran on
  Windows via WSL bash with MSYS/9P translation, which mangled
  backslash paths in args.
- **npm's `.ps1` shim** was resolved by PowerShell with precedence over
  `.cmd` and collided with PowerShell's comma-as-array operator →
  `monoceros init foo --with=a, b` parsed `a b` as a single component
  name instead of two.
- **`taskkill` instead of SIGINT**: Windows has no POSIX process
  groups, `process.kill(-pid, sig)` threw EINVAL → custom teardown
  logic for background spawns.
- **Traefik file-watch defect** on Docker Desktop's gRPC-FUSE bind
  mount: inotify events didn't arrive, dynamic-config changes were
  missed by the running proxy → explicit `docker restart` after every
  yml write.
- **Git Credential Manager**: `git credential fill` triggers OAuth but
  never calls `git credential store` → every apply asked for browser
  auth again.
- **PATHEXT lookup** for `.cmd` shims from Node spawn on Windows
  (post-CVE-2024-27980 lockdown).
- **e2e test specifics**: `.localhost` resolution, process-tree kill,
  shim parsing for e2e's spawn calls.

Each of these points was solvable in isolation, but together they were
both a lot of maintenance overhead and an invitation for every future
feature to prove itself in two worlds.

At the same time, it turned out that **WSL is mandatory on Windows for
Docker Desktop anyway.** There is no Monoceros user on Windows who
doesn't already have WSL installed. The "directly-from-PowerShell" path
therefore saved no tooling effort at all, only a terminal-tab switch.

## Decision

As of 1.12, **WSL is the only supported Windows path**. Concretely:

- `install.ps1` is removed.
- `docs/install-windows.md` documents the WSL setup as the standard and
  only way: enable WSL, install Docker Desktop, turn on WSL integration
  for the distro, install Linux Node+npm in WSL, run `install.sh` from
  within the WSL distro.
- All code that existed specifically to lift the Windows-host variant
  over the friction points is removed:
  - `bootstrapWslBackend()` in `bin.ts` (was a pre-flight for "no WSL
    distro registered" when invoking Windows-host monoceros)
  - `kickProxyReload()` in `proxy/index.ts` (Traefik restart workaround)
  - `dockerLocalFolderLabel()` in `devcontainer/compose.ts` (drive-
    letter normalization)
  - winget branch in `installCommandForOS()` in `credentials.ts`
- In the e2e repo, all Windows-specific code is removed analogously:
  shim parsing in `cli.ts`, the Windows branch in `cli-background.ts`,
  the `dockerLocalFolderLabel` duplicate in `docker.ts`.

## Consequences

- **−547 lines of code in the workbench repo**, −170 lines in the e2e
  repo. The codebase again reflects the original assumption: Monoceros
  is a Linux tool (with macOS as a close relative), and where Linux
  isn't native, it's provided via WSL.
- **One fewer test-matrix axis.** Before: macOS / Linux / Windows host
  / WSL. Now: macOS / Linux / WSL — and WSL differs from Linux only in
  the `/etc/resolv.conf` setup (see the e2e-with-port probe, which uses
  a Host-header trick instead of `*.localhost` resolution — the only
  WSL-specific adaptation that remains).
- **Breaking for Windows-host users pre-1.12.** Anyone who installed
  with `install.ps1` has to migrate to the WSL path. Unlikely to be a
  large pool — Monoceros has only been public since 1.0.0 (≈ end of May
  2026), and the Windows-host path was never pitched as a "lock-in for
  the long term" path. README and `docs/install-windows.md` show the
  WSL way, done.
- **The setup hurdle on Windows is marginally higher**: anyone touching
  Monoceros for the first time has to open a WSL distro instead of
  PowerShell, and grab Linux Node+npm via apt. That's it. Assuming the
  user already had Docker Desktop running (otherwise they couldn't have
  tried Monoceros at all before), WSL is already there; the distro
  opens from the Start menu.
- **ADR 0005 § "Install scripts as bouncer"** is adjusted: only
  `install.sh` now, no PowerShell counterpart.

## Non-goals of this ADR

- **A blanket ban on Windows-host code.** If a concrete use case could
  be cleanly justified in the future (e.g. a systemd-free Windows
  variant for a specific enterprise scenario), it can be re-evaluated.
  This ADR only says: in 1.x it's not in scope, it costs more than it
  brings.
- **WSL 1 support.** Monoceros needs Docker Desktop, which needs WSL 2.
  WSL 1 is not in scope.
- **Native Windows containers.** Docker Desktop's Windows-container mode
  doesn't run on the WSL 2 backend, so it's not supported. Monoceros
  was never built for Windows containers anyway — Linux containers are
  the assumption of the entire image pipeline.

## References

- [`install.sh`](../../install.sh) — the only installer
- [`docs/install-windows.md`](../install-windows.md) — WSL setup doc
- ADR 0005 § "Install scripts as bouncer" (`install.ps1` path
  superseded by this ADR)
- ADR 0007 § "Port management via Traefik" (the file-provider path
  stays; the Windows-specific restart hack is dropped with this ADR)
