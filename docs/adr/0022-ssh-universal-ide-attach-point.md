# ADR 0022: SSH as the Universal IDE Attach Point

- Status: accepted
- Date: 2026-06-16

## Context

`monoceros apply` brings the container up via the `devcontainer` CLI and,
today, implicitly assumes the **VS Code Remote model**: [ADR 0015](./0015-persist-ide-state-across-rebuilds.md)
persists `~/.vscode-server` so a builder's extensions and settings survive
a rebuild. That is the only IDE the workbench is wired for.

Attaching an editor to an **already-running** container without restarting
it is, on Microsoft VS Code, the proprietary _Attach to Running Container_
command. That command:

- is **not available on VS Codium** - the Microsoft Dev Containers
  extension is not published to Open VSX, and the community alternatives
  either take over the container lifecycle (DevPod, `devcontainer up`,
  which rebuild) or need an SSH server in the container that the runtime
  image does not ship today;
- ties the workbench to **one editor family**, which contradicts the
  product's stance: stack-agnostic, no built-in UI, tooling first-class.
  Editor choice should be the builder's, not the workbench's.

Builders want Codium, IntelliJ, and Zed. All three - and a plain terminal -
do remote development the same way: **over SSH**. The client connects, drops
its backend into the remote, and runs there. That is one contract the
workbench can satisfy once, for every editor, without restarting a running
container.

## Decision

### 1. Ship `sshd` in the runtime image, active by default

`sshd` becomes part of the runtime base alongside `git`, `curl`, `jq`, and
`socat` - not an opt-in component. It is simply present and running. No
presence checks, no "install it first" rebuild step.

This deliberately places `sshd` **outside** the [ADR 0019](./0019-component-taxonomy-service-feature-dependency.md)
service / feature / dependency taxonomy: it is base infrastructure, not a
selectable component.

`sshd` is hardened: key-only auth, no password, no root login, and it
listens on port 22 **inside the container only** - never published to the
host.

sshd is brought up by an image-baked script (`monoceros-sshd-up.sh`) run
from each container's `postStartCommand`, **not** the image ENTRYPOINT.
devcontainer-cli overrides the entrypoint in image mode (it runs the
container as a `/bin/sh` keep-alive), so the entrypoint never executes -
the same reason the ADR-0002 egress entrypoint proved unreliable. A
postStartCommand runs in both image and compose mode and on every start,
so sshd also survives a `stop`/`start`. The script (via `sudo`; the node
user has passwordless sudo) generates host keys, installs the builder's
public key from the `/workspaces/*/.monoceros/ssh/*.pub` glob, and starts
sshd idempotently. The scaffold only emits the postStartCommand when the
pinned runtime ships sshd (>= 1.2.0).

**Revision (issue #20, runtime >= 1.3.6): also start sshd from the
entrypoint.** The claim above that "a postStartCommand runs on every start"
holds only for devcontainer-managed starts (`apply` / `monoceros start`). A
plain `docker restart`, a Docker Desktop restart, or a host reboot restarts
the container's PID 1 but does **not** re-run the devcontainer lifecycle
hooks - so sshd stayed down until the next `monoceros start`. The fix moves
the bring-up to where it belongs for a "survives any restart" daemon: the
image entrypoint runs `monoceros-sshd-up.sh` on every container start. The
original objection (the entrypoint never executes in image mode because
devcontainer-cli overrides the command) is removed by setting
`overrideCommand: false` in the image-mode `devcontainer.json`, so the image's
own ENTRYPOINT + a baked `CMD ["sleep","infinity"]` keep-alive run as PID 1.
Compose mode needs no change - the image entrypoint already runs there. The
entrypoint runs as root, so the Windows bridge port reaches the script through
`MONOCEROS_SSH_PUBLISH_PORT` in the container env (no `sudo` to strip it),
while the postStartCommand keeps passing it as an argument. The
postStartCommand is kept as the first-run / `monoceros start` path. Gated on
the runtime version because the keep-alive `CMD` and entrypoint bring-up only
exist from 1.3.6 on; below it the default override stays.

### 2. Per-container keypair, workbench-managed

`apply` mints a dedicated `ed25519` keypair per container:

- private key under `container/<name>/.monoceros/ssh/id_ed25519` (the
  `.monoceros/` directory is already gitignored);
- public key injected into the container's `authorized_keys`.

This mirrors how git identity is already collected and written via
`collectGitIdentity()`. The workbench **never depends on the builder owning
a host SSH key** - "no key present" is therefore a non-case, not an error
path. The minted key opens **only that one container**, so the builder's
personal `~/.ssh` identity is never entangled.

### 3. Portless transport via `docker exec` + `socat`, zero-config

`apply` writes a per-container OpenSSH `Host` block to
`<MONOCEROS_HOME>/ssh/config.d/<name>`:

```
Host monoceros-<name>
    User node
    IdentityFile "<MONOCEROS_HOME>/container/<name>/.monoceros/ssh/id_ed25519"
    IdentitiesOnly yes
    StrictHostKeyChecking no
    UserKnownHostsFile /dev/null
    ProxyCommand "<MONOCEROS_HOME>/ssh/exec-<name>.sh"
```

The `ProxyCommand` points at a small generated wrapper script rather than
a fixed container name: the image-mode container name is non-deterministic
(devcontainer-cli assigns e.g. `thirsty_bartik`), so the script resolves
the running container by its `devcontainer.local_folder` label - the same
handle `monoceros shell` uses - and execs `socat - TCP:127.0.0.1:22` into
it. Resolving by label rather than a baked-in name means the entry follows
rebuilds (the container id changes, the label does not) and prints an
actionable error when the container is not running. `sshd` listens only
inside the container; `socat` is already a runtime dependency established by
[ADR 0009](./0009-tcp-tunnels-foreground-sidecar.md). Host keys are
ephemeral (regenerated per container), so the entry disables host-key
checking - there is no persistent identity to pin.

`apply` also ensures - idempotently, once - an `Include
"<MONOCEROS_HOME>/ssh/config.d/*"` line in the builder's `~/.ssh/config`;
`remove` deletes the per-container config entry and wrapper script (the
keypair goes with the container directory; the `Include` line stays, since
it harmlessly globs and other containers rely on it).

The result is genuine zero-config. The builder touches no key and no port:

- terminal: `ssh monoceros-<name>`
- any IDE: select host `monoceros-<name>`

No published port, no host-network exposure, and `docker exec` needs only
the Docker access the builder already has - no new privilege.

### 4. Generalize IDE-state persistence (extends ADR 0015)

[ADR 0015](./0015-persist-ide-state-across-rebuilds.md) persists only
`~/.vscode-server`. This is generalized to a **per-IDE allowlist of
in-container backend sub-directories** (option A, chosen over persisting a
broad swath of the home directory):

| IDE family       | In-container backend directory                        | Status     | Since runtime |
| ---------------- | ----------------------------------------------------- | ---------- | ------------- |
| VS Code Remote   | `~/.vscode-server`                                    | confirmed  | 1.1.0         |
| VS Codium Remote | `~/.vscodium-server`                                  | confirmed  | 1.2.0         |
| JetBrains        | `~/.cache/JetBrains` + `~/.config` + `~/.local/share` | confirmed  | 1.3.0         |
| Claude Code SSH  | `~/.claude/remote`                                    | confirmed  | 1.3.3         |
| Zed              | `~/.zed_server`                                       | to confirm | -             |

Confirmed via `open-remote-ssh` on Codium: it lays down `~/.vscodium-server`
with the same `extensions/` + `data/User/` sub-dirs as VS Code, so both get
named volumes on those two sub-dirs (never the whole server dir - `bin/`
stays IDE-owned, per ADR 0015). The VS Codium volumes are gated on runtime
1.2.0; the VS Code pair stays gated on 1.1.0. Zed is added once its
in-container backend dir is confirmed - until then a builder who needs it
opens a ticket (see Consequences).

JetBrains (confirmed via WebStorm over Gateway) is different and forced a
departure from ADR 0015's strict per-container rule. Measured footprint
under `~/.cache/JetBrains/RemoteDev`: `dist/` is the ~3 GB IDE backend
distribution, **identical across containers**; its siblings `active/`,
`recent/`, `remote-dev-worker/` are tiny per-user session state. The rest
(`~/.cache/JetBrains/<Product><Version>` indexes/LocalHistory,
`~/.config/JetBrains`, `~/.local/share/JetBrains`) is per-project/per-
container. So the split is:

- **Shared, machine-wide** (downloaded once, like the Traefik proxy
  singleton): **only** `~/.cache/JetBrains/RemoteDev/dist` -> one
  `monoceros-jetbrains-dist` volume, reused by every container, **not**
  deleted by `monoceros remove <name>` (reclaim explicitly with `docker
volume rm`).
- **Per-container:** `~/.cache/JetBrains` (project indexes **and** the
  RemoteDev session state `active/`+`recent/`+`remote-dev-worker/`; the
  shared `dist` volume nests inside it), `~/.config/JetBrains`,
  `~/.local/share/JetBrains` - all `monoceros-<name>-jetbrains-*`, deleted
  on remove.

An earlier cut shared the whole `RemoteDev` dir, which pooled every
container's `recent/` + `active/` state - WebStorm's "Recent SSH Projects"
then showed one merged, cross-container list. Sharing **only** `dist/`
fixes that while keeping the download-once win. The shared `dist` volume is
gated on runtime 1.3.2 (the image pre-creates `.../RemoteDev/dist`
node-owned there); the per-container JetBrains volumes are gated on 1.3.0.
This is the only place a Monoceros volume is shared across containers,
justified by the multi-GB, container-identical distribution - the same
reasoning that makes the proxy a singleton.

Claude Code's own desktop app attaches over this same SSH point and joins
the allowlist for a different reason than the IDEs. Its `claude-ssh` remote
server binds an rpc socket under `~/.claude/remote/run/<id>/rpc.sock` and
`chmod`s it; on Docker Desktop `~/.claude` is a VirtioFS/`fakeowner` host
mount, where `chmod` on a **socket inode** fails with `EINVAL`
(docker/for-mac#6614) - the daemon never reaches accept and the app times
out with "Failed to start remote server". A per-container
`monoceros-<name>-claude-remote` volume puts the whole `remote/` tree on
container-native storage where the chmod works, and persists the (~230 MB)
downloaded server across rebuilds. Only `remote/` moves to the volume; the
rest of `~/.claude` (auth, config) stays on the host mount, host-visible.
Gated on runtime 1.3.3 (the image pre-creates `~/.claude/remote`
node-owned there).

As in ADR 0015, volumes target **sub-directories the IDE writes into**,
never a whole IDE-owned directory - that lesson (VS Code owns `bin/`)
carries over and avoids the "configuration changed - rebuild?" loop.

Note the host/container distinction: a builder's host-side client dirs
(VS Code `~/.vscode`, VS Codium `~/.vscode-oss` / `~/.vscode-oss-shared`)
live on the host, persist naturally, and are **not** what these volumes
cover. Only the in-container backend dirs need persisting.

The exact in-container paths are confirmed empirically on the first remote
connection per IDE (connect, `ls ~`), not guessed.

### 5. Windows/WSL bridge

On Windows the CLI runs in WSL (ADR 0011), so the `Host monoceros-<name>`
entry + key + ProxyCommand land in WSL's `~/.ssh/config`. But the editor
(Codium / VS Code / JetBrains Gateway) runs on **Windows** and reads
`C:\Users\<user>\.ssh\config` - it never sees the WSL entry, so
`monoceros-<name>` is unresolvable. Docker Desktop's WSL2 backend is the
bridgehead: the same daemon (hence the same container) is reachable from
both WSL (`docker`) and Windows (`docker.exe`).

So when `apply` detects it is running under WSL, it **additionally** writes
the connection on the Windows side (verified manually before automating -
plain `ssh.exe monoceros-<name>` and Codium both connect):

- **Resolve the Windows profile from WSL** via `cmd.exe /c echo
%USERPROFILE%` (strip CR) + `wslpath` - no extra package. The username is
  the last segment of `C:\Users\<user>`.
- **Key in a Monoceros-owned subdir** `…\.ssh\monoceros\<name>` (NOT
  `.ssh\` itself), so it can never clobber a user key of the same name.
  ACLs locked with `icacls.exe` (OpenSSH-Windows rejects open keys).
- **A marked Host block** (`# >>> monoceros monoceros-<name> >>>` … `<<<`)
  upserted into the user's Windows `~/.ssh/config`: found + replaced
  surgically, the rest of the builder's config untouched. The block uses
  the Windows key path, the deterministic container name, and
  `ProxyCommand docker exec -i monoceros-<name> socat - TCP:127.0.0.1:22`
  (host-agnostic transport; `socat` runs in-container, `docker` is
  docker.exe on the Windows PATH). Host-key checking disabled, as on the
  WSL side.
- `remove` clears the Windows key + marked block too.

No-op on macOS / native Linux (`realIsWsl()` is false). JetBrains Gateway
on Windows reads the same Windows config + ProxyCommand, so it is expected
to work like Codium - to be confirmed on a real Gateway connection.

#### Windows: the Claude desktop app needs a direct port, not a ProxyCommand

The Claude desktop app connects with a bundled `ssh2` (not system OpenSSH).
On Windows it spawns the `ProxyCommand` via `sh -c`, and Windows has no `sh`
(`spawn sh ENOENT`) - so the docker-exec transport never runs and the
connect times out. The same `ssh2` also does **not** trust-on-first-use: it
rejects a host whose key is not already in `~/.ssh/known_hosts` (it reads
`~/.ssh/known_hosts` and ignores the `UserKnownHostsFile` directive). System
OpenSSH (terminal, VS Code/Codium/JetBrains) is unaffected - it runs the
ProxyCommand fine and honours `StrictHostKeyChecking no`. So for the Windows
desktop app only:

- **Direct port instead of ProxyCommand.** A Windows-side socat forwarder in
  the container (env-gated, sshd stays loopback-only) listens on a container
  port that `apply` publishes to `127.0.0.1:<port>` on the host; the Windows
  `Host` block becomes `HostName 127.0.0.1` / `Port <port>`, no ProxyCommand.
- **Stable host keys.** `sshd-up.sh` now persists the host keys across
  rebuilds (instead of regenerating), so a `known_hosts` entry stays valid.
- **`apply` writes the host key to `~/.ssh/known_hosts`** - under the alias
  `monoceros-<name>` on macOS/Linux, under `[127.0.0.1]:<port>` on Windows -
  so `ssh2`'s no-TOFU check passes.

Consequences for existing paths: **none on macOS/Linux** - they keep the
portless ProxyCommand transport; the stable host key is invisible to system
OpenSSH (it disables host-key checking) and the `known_hosts` entry only
matters to the app. The one new exposure is the Windows `127.0.0.1`-bound,
key-only published port.

### 6. Always-on host-browser bridge for attach sessions

The Host-Browser-Bridge (a relay `xdg-open` whose URL is opened on the host
by a watching host process) was wired only into `monoceros run`/`shell`: the
watcher lived in that transient CLI process, and `wrapExec` put the relay on
`PATH` + `$BROWSER` for that one exec. A session this attach point creates -
the IDE/desktop-app remote server spawns the shell or agent directly in the
container - goes through neither, so a tool inside (or the agent opening the
running app) had no way to reach the host browser. This was the deferred
"in-container terminals don't get the bridge" limitation.

The fix makes the bridge always-on for a running container, in two halves:

- **Relay in the image, not per-session** (>= 1.3.3): a real `xdg-open` at
  `/usr/local/bin/xdg-open` (on PATH) that writes the URL to the single
  workspace's `.monoceros-bridge/url`, plus `ENV BROWSER` pointing at it. So
  EVERY process - interactive or not, including ones the `claude-ssh` daemon
  spawns - relays through it without any per-session env wiring. It is
  self-healing (recreates the relay dir if a `run`/`shell` session disposed
  it) and exits 0 unconditionally.
- **A host-side daemon bound to the container lifecycle.** `apply`/`start`
  spawn a detached `monoceros __bridge <root>` that runs the SAME watcher
  (`watchRelayUrl`, shared with the per-session bridge) for the container's
  whole lifetime: it opens each relayed URL on the host and replays a
  localhost OAuth callback in. It self-exits when the container stops (polls
  `isWorkspaceRunning`), is SIGTERM'd by `remove`, and a pid file under the
  relay dir makes the spawn idempotent. Gated on runtime 1.3.3 (below that
  the image has no relay, so the daemon would watch a file nothing writes).

The `~/.claude/remote` volume (section 4 table) is what lets the remote
server start at all on Docker Desktop; this is what lets a tool in that
session reach the host browser once it has.

## Rationale

- **One SSH contract, many editors.** Instead of a per-IDE extension story,
  the workbench exposes a single attach point and is done. Codium,
  IntelliJ (JetBrains Gateway / Remote Development), Zed, and any terminal
  tool all ride the same `sshd`.
- **No restart.** Once the container is up, attaching is just connecting.
  This removes the "why would I restart a running container" friction of
  lifecycle-owning tools.
- **Editor-agnostic by construction**, matching the product philosophy
  rather than quietly favouring VS Code.
- **Zero-config and portless** match two existing workbench promises: the
  builder configures nothing, and the rest of the host stays unexposed.

## Consequences

- Runtime image change: add `sshd`, ensure `socat` is present.
- `apply` / `remove` gain: keypair minting, `authorized_keys` injection,
  `~/.monoceros/ssh/config.d/` management, and the idempotent `Include`
  line in `~/.ssh/config`. The `~/.ssh/config` edit is additive, clearly
  marked, and removable - the workbench never rewrites existing entries.
- The IDE-state allowlist needs per-IDE maintenance. That is the accepted
  cost of option A. **Docs guidance:** if a builder needs another IDE's
  backend directory persisted, they open a ticket and it is added to the
  allowlist.
- Exact in-container backend paths (notably the Codium server dir and the
  JetBrains remote-dev backend) are confirmed empirically before their
  rows are treated as authoritative.
- **Image-mode lifecycle enabled.** The attach workflow makes long-lived
  image-mode containers (no services) the norm - a builder stops one to
  free resources and starts it again to reattach. `start`, `stop`, and
  `status` were previously compose-only; they are now mode-aware (`start`
  via `devcontainer up`, which already handles both modes; `stop`/`status`
  via plain `docker` on the `devcontainer.local_folder`-labeled container).
  `logs` stays compose-only - a bare container's main process is just the
  keep-alive, so there is nothing useful to tail.

## Related

- [ADR 0009](./0009-tcp-tunnels-foreground-sidecar.md) - establishes the
  `socat` dependency reused here for the portless transport.
- [ADR 0015](./0015-persist-ide-state-across-rebuilds.md) - IDE-state
  persistence, generalized from VS Code only to a per-IDE allowlist here.
- [ADR 0019](./0019-component-taxonomy-service-feature-dependency.md) -
  `sshd` is deliberately excluded from this taxonomy as base
  infrastructure.
