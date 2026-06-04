# Setting up Docker on Linux

> Draft, 2026-05-24. Expanded and refined over the course of M5.
> Goal: everything relevant to the Docker setup for Monoceros in
> one place, instead of scattered across install.sh error boxes and
> backlog notes.

This page is for builders working **locally on a Linux desktop**
(e.g. Ubuntu in a VM, or a native Linux workstation).

For macOS and Windows, Docker Desktop is the documented path — none
of the group drama described here applies there, because Docker
Desktop brings its own access mechanism.

---

## TL;DR — three commands and you're done

```sh
sudo -v
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
```

That's it. **No `newgrp docker`**, no logout, no reboot.
Monoceros' CLI detects the "the user is in `/etc/group`, but my
shell doesn't know about it" state and handles it internally (see
["Auto-recovery in Monoceros"](#auto-recovery-in-monoceros) below).

Then run `curl -fsSL https://raw.githubusercontent.com/getmonoceros/workbench/main/install.sh | bash`
and you're through.

---

## What the three commands mean

### 1. `sudo -v`

Caches the sudo password for the next ~15 minutes. It looks
trivial, but it matters: without this pre-caching, sudo asks for
the password **later** in the block, and in a pasted block the
following command would be interpreted as "typed input for the
password prompt" — it would silently get swallowed.

If you type the commands one by one and dutifully wait for each
prompt, `sudo -v` is redundant. In practice you paste the block,
which is why it's there.

### 2. `curl -fsSL https://get.docker.com | sudo sh`

Installs **Docker Engine in rootful mode**. This is the path
Monoceros supports. The Docker daemon runs as root, managed by
systemd, with its socket at `/run/docker.sock`.

At the end the script prints a notice block:

```
To run Docker as a non-privileged user, consider setting up
the Docker daemon in rootless mode for your user:

    dockerd-rootless-setuptool.sh install
```

**Ignore that block.** It's an alternative installation variant
(rootless mode), not a step that still needs doing. Monoceros does
not currently support rootless (see
["Rootless Docker — not supported"](#rootless-docker--nicht-unterstützt)).

### 3. `sudo usermod -aG docker $USER`

Adds your user to the `docker` group. The daemon socket is
root-owned (mode `0660`, owner `root:docker`); without group
membership you'd have to prefix every `docker` call with `sudo` —
a UX death.

**Security context:** anyone in the docker group is **effectively
root** on a normal Linux machine. You can start a container with
`--privileged -v /:/host` and thereby modify the entire host
system.

On a **single-user dev VM** (your setup) this is not a new security
hole — you already have `sudo` rights anyway. The docker group is
just a more convenient way to get there, not an additional one.

On a **multi-user server** the group would matter: an
unprivileged user you grant `docker` to suddenly becomes
root-equivalent. Different threat model, different setup — not
Monoceros' use case.

---

## The GNOME session trap

After `sudo usermod -aG docker $USER`, your user is listed in
`/etc/group` — immediately, persistently. What you **can** do:

```sh
getent group docker
# → docker:x:984:parallels   ✓ you're in
```

What you **can't** do: run `docker info`. Result:

```
permission denied while trying to connect to the docker API
at unix:///var/run/docker.sock
```

**Why?** Linux reads group memberships at **login** (via PAM) and
stores them as an immutable list in the process credentials of
every newly started process. There is **no kernel syscall** that
can add new group memberships to a running process from the
outside — and that's by design (otherwise a malicious process
could grant itself privileges).

Your GNOME desktop session was started **before** you ran
`usermod`. It has a frozen group list **without** docker. Every
process descended from that session — every terminal window, every
editor, every tab — inherits that stale list.

### What actually works

Three ways to get Docker access into your shell without rebooting:

| Command                | Effect                                                  | Scope               |
| ---------------------- | ------------------------------------------------------- | ------------------- |
| `newgrp docker`        | opens a sub-shell with the docker group set as primary  | only this sub-shell |
| `sg docker -c "<cmd>"` | runs ONE command with the docker group                  | only this command   |
| `su - $USER`           | starts a fresh PAM login session, asks for the password | only this sub-shell |

**Permanent for all future terminals**: a full GNOME session
logout (not "close the terminal", but "log out of the graphical
session"), then log back in. At login, PAM re-reads `/etc/group`
fresh.

A reboot works too — but it's overkill (a logout is enough).

---

## Auto-recovery in Monoceros

Here's the trick: **Monoceros doesn't wait for you to sort out the
group drama by hand.**

At the start of every `monoceros …` call, a bootstrap runs
(`packages/cli/src/devcontainer/docker-group-bootstrap.ts`):

1. Probe: `docker info` — does it work?
2. If yes: nothing to do, carry on as normal.
3. If no **and** the user is listed in `/etc/group`'s docker line
   (= `usermod` ran, the shell just doesn't know yet): monoceros
   re-execs itself via `sg docker -c "node …"`. `sg`
   (shadow-utils) reads `/etc/group` fresh and runs the command
   with the docker group active.
4. If the user is **not** in `/etc/group`: a clear error message
   with the `usermod` hint.

From your point of view: you type `monoceros apply hello` and it
works. Bash sees **one** command, history gets **one** line, the
↑ arrow works. The `sg` sub-process lives only as long as the
monoceros execution, then it's gone.

Overhead: two `spawnSync` calls (`docker --version` + `docker
info`) per monoceros call, ~50 ms total.

After the next natural GNOME logout (end of day, reboot, update)
the group propagates anyway: `docker info` in the probe succeeds
immediately, and the `sg` re-exec automatically switches itself
off.

**Same thing in install.sh:** if you run install.sh while your
shell is still stuck in the "usermod-but-not-loaded" trap,
install.sh also re-execs itself via `sg docker`. The curl-bash
setup is tricky (stdin is already consumed), so we re-download to
a tmpfile and exec `sg docker -c "bash $tmpfile"`.

---

## Rootless Docker — not supported

Docker has a rootless mode
(`dockerd-rootless-setuptool.sh install`) in which the daemon runs
as an unprivileged user. It sounds appealing, but it's problematic
for Monoceros' devcontainer workflow:

- **Bind-mount UID shift**: in rootless, the host user is mapped to
  container UID 0 (root); the container default user (`node` with
  UID 1000) is mapped to host UID 65536+999. Files the container
  writes as `node` land on the host with a UID the builder user
  can't edit without sudo. This breaks the "edit on host, run in
  container" model.

- **The `idmap` mount option that would solve this** exists in the
  Linux kernel — but **Docker doesn't expose it via `--mount`**
  (verified in the [Docker bind-mounts docs](https://docs.docker.com/engine/storage/bind-mounts/)).
  Podman does; Docker doesn't yet. Without idmap, there's no clean
  fix.

- **The "run the container as root" workaround** would work (host
  user maps to container root, file ownership is correct), but it
  brings HOME path mismatches (container tools look for configs
  under `/root/.x`, not `/home/node/.x`), npm-as-root warnings, and
  general friction.

If you explicitly need rootless Docker (compliance, multi-user
server policy), Monoceros isn't the right tool today. If real
builder demand shows up, this could become its own feature or an
ADR discussion — for now it's deliberately out of scope.

**A note on the path back to rootful**, in case you accidentally
installed rootless:

```sh
# Disable rootless
systemctl --user stop docker.service docker.socket 2>/dev/null || true
dockerd-rootless-setuptool.sh uninstall
rootlesskit rm -rf ~/.local/share/docker
unset DOCKER_HOST DOCKER_CONTEXT

# Enable rootful (should already be there from the get.docker.com
# install, otherwise run install.sh again)
sudo systemctl enable --now docker
sudo usermod -aG docker $USER
```

Plus: check `~/.bashrc` / `~/.profile` for leftover `DOCKER_HOST`
and `DOCKER_CONTEXT` entries — the rootless setup tool likes to
write things there that otherwise keep sending new shells to the
rootless socket:

```sh
grep -E 'DOCKER_HOST|DOCKER_CONTEXT' ~/.bashrc ~/.profile 2>/dev/null
```

If you get hits → edit them out or strip them with `sed -i`.

Verify:

```sh
docker info | grep -i rootless   # → must be empty
docker info | grep "Docker Root Dir"   # → /var/lib/docker
```

If `docker info` throws permission-denied, your current shell
hasn't loaded the docker group yet — just run `newgrp docker` or
call `monoceros apply <name>` directly; the auto-recovery
bootstrap will catch it.

---

## Common error messages + diagnosis

### `permission denied while trying to connect to the docker API`

A classic. It means: the Docker daemon is running, but your shell
has no access. Possible causes:

1. **User not in the `docker` group**: `getent group docker`. If
   you're not in the last column, run `sudo usermod -aG docker
$USER`.
2. **User is in the `docker` group, but the shell hasn't loaded
   it**: the GNOME session trap. Monoceros auto-recovery should
   catch this — if not: `newgrp docker` once, manually.
3. **Docker rootless without you wanting it**: `docker info | grep
-i rootless` → if anything shows up, see the notice block above.

### `Cannot connect to the Docker daemon`

The daemon isn't running. `sudo systemctl status docker` and, if
needed, `sudo systemctl start docker`. If it won't start, look in
the journal (`journalctl -u docker.service -n 50`).

### `getent group docker` is empty

The group wasn't created. Unusual after `get.docker.com`. Create
it manually:

```sh
sudo groupadd docker
sudo usermod -aG docker $USER
```

---

## References

- [ADR 0006 — HTTPS-only repo auth](./adr/0006-https-only-repo-auth.md) —
  why SSH repo auth is out of scope (a related cross-platform topic)
- [Docker Engine Install — official docs](https://docs.docker.com/engine/install/)
- [Docker Engine Post-Installation Steps](https://docs.docker.com/engine/install/linux-postinstall/) —
  upstream docs on the docker group topic
- [`packages/cli/src/devcontainer/docker-group-bootstrap.ts`](../packages/cli/src/devcontainer/docker-group-bootstrap.ts) —
  source of the auto-recovery mechanism
