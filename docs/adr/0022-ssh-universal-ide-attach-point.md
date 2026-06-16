# ADR 0022: SSH as the Universal IDE Attach Point

- Status: proposed
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

| IDE family       | In-container backend directory                  | Status     |
| ---------------- | ----------------------------------------------- | ---------- |
| VS Code Remote   | `~/.vscode-server`                              | confirmed  |
| VS Codium Remote | (its own server dir, e.g. `~/.vscodium-server`) | to confirm |
| JetBrains        | `~/.cache/JetBrains` (+ remote-dev backend)     | to confirm |
| Zed              | `~/.zed_server`                                 | to confirm |

As in ADR 0015, volumes target **sub-directories the IDE writes into**,
never a whole IDE-owned directory - that lesson (VS Code owns `bin/`)
carries over and avoids the "configuration changed - rebuild?" loop.

Note the host/container distinction: a builder's host-side client dirs
(VS Code `~/.vscode`, VS Codium `~/.vscode-oss` / `~/.vscode-oss-shared`)
live on the host, persist naturally, and are **not** what these volumes
cover. Only the in-container backend dirs need persisting.

The exact in-container paths are confirmed empirically on the first remote
connection per IDE (connect, `ls ~`), not guessed.

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

## Related

- [ADR 0009](./0009-tcp-tunnels-foreground-sidecar.md) - establishes the
  `socat` dependency reused here for the portless transport.
- [ADR 0015](./0015-persist-ide-state-across-rebuilds.md) - IDE-state
  persistence, generalized from VS Code only to a per-IDE allowlist here.
- [ADR 0019](./0019-component-taxonomy-service-feature-dependency.md) -
  `sshd` is deliberately excluded from this taxonomy as base
  infrastructure.
