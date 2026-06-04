# ADR 0005 — CLI distribution via npm

- Status: accepted
- Date: 2026-05-20
- Amendment 2026-06-01: § "Install scripts as bouncers" — `install.ps1`
  retired, the Windows path has run through WSL since 1.12. See
  [ADR 0011](0011-wsl-only-auf-windows.md). The `install.sh` part of the
  section remains valid as-is and applies to macOS / Linux / WSL.

## Context

ADR 0004 had planned platform-specific tarballs for the CLI
(`darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`,
`windows-x64`) plus install scripts as wrappers. The idea behind it
was "Docker is the only host prerequisite" — the CLI build was
supposed to bundle Node internally so that users could get by without
a Node installation.

While working out the details, two problems surfaced:

1. **The devcontainer CLI is an embedded Node subprocess.**
   Monoceros references `@devcontainers/cli` as an npm dependency and
   spawns its JS bin via `node <path>` (see
   [`packages/cli/src/devcontainer/cli.ts`](../../packages/cli/src/devcontainer/cli.ts)).
   A single-executable build via Node SEA or Bun could bundle our own
   code — but then `process.execPath` would point at our own binary,
   not at a generic Node, and SEA has no second entry point by design.
   Without a significant architectural overhaul (devcontainer-cli
   in-process, losing subprocess isolation and secret masking) or a
   second SEA construction (doubling the tarball size), Node remains a
   prerequisite anyway.

2. **The CLI is pure JS.** There is no platform-specific code, no
   native bindings, no binary layer. Building five platform-specific
   tarballs just to avoid Node duplicates work that the npm registry
   does for free.

## Decision

CLI distribution happens via the npm registry as
`@getmonoceros/workbench`. One artifact per version, cross-platform,
without binary bundling.

**Prerequisites on the user's machine:**

- **Docker** (daemon reachable — we check `docker info`, not just the
  existence of the binary)
- **Node ≥ 20** (with `npm` from the same installation)

If either is missing, Monoceros cannot be installed. Full stop. We do
not try to install Docker or Node ourselves — the user stays in
control of what makes its way into their toolchain.

**Install scripts as bouncers.** The repo root holds
[`install.sh`](../../install.sh) (macOS + Linux) and
[`install.ps1`](../../install.ps1) (Windows). Each one checks Docker
and Node in turn, prints a platform-specific guide with links + exit 1
if something is missing, and otherwise runs
`npm install -g @getmonoceros/workbench`. From the user's point of
view:

```sh
curl -fsSL https://raw.githubusercontent.com/getmonoceros/workbench/main/install.sh | bash
```

(or the PowerShell equivalent). If a prerequisite is missing, install
it and run again.

**What the scripts do NOT do:**

- They install neither Docker nor Node automatically.
- They do not perform `nvm`/`fnm`/`volta` setups in the background.
- They change no system configuration beyond the `npm install -g`
  call (which in turn depends on the user's npm configuration — by
  default user scope on Windows, system scope on Unix setups via
  Homebrew/apt).

**Node installation hints** in the scripts list both common paths —
system packages (`brew install node`, `winget install OpenJS.NodeJS`,
`apt install nodejs`) and per-user managers (`nvm`, `fnm`, `volta`,
direct ZIP) — without the script itself making a choice.

**Release mechanics** follow the pattern from ADR 0004 §
"Version-triggered pipelines". The CLI release workflow
(`release-cli.yml`):

- Trigger: `paths: ['packages/cli/**']` on `main`, plus
  `workflow_dispatch`
- Reads the version from `packages/cli/package.json`
- Compares against the npm registry (`npm view @getmonoceros/workbench@<version>`)
- If new: `npm publish --access public`, otherwise skip

Auth via **npm Trusted Publishing** (OIDC) — no long-lived token in
the repository, no special 2FA-bypass form. The workflow exchanges a
short-lived OIDC token from GitHub for a publish token from the npm
registry, which knows the relationship between workflow and package
from the package's trusted-publisher settings. Provenance attestation
is signed along automatically.

Caveat: npm Trusted Publishing requires that the package already
exists (see [npm/cli#8544](https://github.com/npm/cli/issues/8544)).
The very first publish of `@getmonoceros/workbench@1.0.0` therefore
runs manually from the maintainer's machine (`npm login` with 2FA →
`npm publish --access public`). After that, the trusted publisher is
configured on npmjs.com and all further releases run automatically
through the workflow.

## Consequences

- **ADR 0004 § "Platform matrix for the CLI" is superseded.** The
  five tarballs go away, the build-tooling discussion (Bun vs SEA vs
  pkg) is moot. The rest of ADR 0004 (three artifact types, version
  detection, no staging) remains valid.
- **`packages/cli/package.json` needs publish setup:** remove
  `private: true`; fill in `version`, `description`, `bin`, `files`
  (only `dist/`, `package.json`, `README`), `repository`, `homepage`,
  `license`, `engines`; add a `prepublishOnly` script with typecheck
  - test; point the `build` script at `tsup` (or equivalent) for
    `dist/` output.
- **The CLI tool install path** now lives wherever npm has configured
  its global prefix (`/usr/local/lib/node_modules/`,
  `%APPDATA%\npm\node_modules\`, Homebrew Cellar, etc.). Monoceros
  itself does not know this path and does not need to know it — npm
  puts the `bin` shim on the PATH and that's it.
- **Backlog M4 Task 5** becomes smaller and more concrete: an npm
  publish workflow plus two bouncer scripts, instead of a
  platform-matrix build pipeline.
- **Bootstrap sequence for the first publish:**
  1. Locally `cd packages/cli && npm login && npm publish --access public`
     — claims the `@getmonoceros` scope and creates
     `@getmonoceros/workbench@1.0.0`.
  2. Configure the trusted publisher at
     <https://www.npmjs.com/package/@getmonoceros/workbench/access>:
     org `getmonoceros`, repo `workbench`, workflow
     `release-cli.yml`.
  3. From the next version bump on, the workflow publishes without
     token setup on the repo side.

## Non-goals of this ADR

- **Userspace-specific Windows distribution.** We do not build
  special handling for locked-down corporate Windows without admin
  rights. If the user gets Docker running on their machine — Docker
  Desktop fundamentally needs admin — everything else runs via
  userspace Node options as usual. If not, that is a showstopper
  before Monoceros, not a Monoceros problem.
- **Brew tap / WinGet manifest / Scoop bucket.** Wrappers over the
  npm distribution that can emerge later if there is real demand. For
  now, the direct install path.
- **Auto-update of the installed CLI.** Manually via
  `npm update -g @getmonoceros/workbench` or re-running the install
  script. Auto-update mechanics come in a later stage, if at all.
- **Bundling the devcontainer CLI into the monoceros codebase.**
  Stays an npm dependency as before, comes along automatically via
  `npm install -g`.
