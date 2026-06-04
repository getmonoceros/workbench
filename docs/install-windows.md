# Setting up Monoceros on Windows

Monoceros runs on Windows **inside WSL** — that is, as a Linux tool in
a WSL 2 distro (typically Ubuntu). Docker Desktop provides the daemon,
WSL provides the Linux environment in which Monoceros is installed and
run. There is no separate Windows host installer anymore — the old
`install.ps1` variant had too many friction points (drive-letter case,
cmd.exe quoting, the GCM auth dance, broken Traefik file-watching on
gRPC-FUSE bind mounts) and was dropped in 1.12.

On macOS and native Linux the path is different; for native Linux see
[`docker-on-linux.md`](docker-on-linux.md).

---

## What Docker Desktop builds on, on Windows

Docker Desktop runs on Windows via the **WSL 2 backend**. That means
three building blocks that have to line up:

1. **Hardware virtualization** (VT-x / AMD-V) — enabled in the BIOS.
2. **WSL 2** — the platform _and_ at least one installed Linux distro.
3. **Docker Desktop** itself, in WSL 2 mode.

If building block 2 is missing, Docker Desktop won't start and reports
— somewhat misleadingly — "Virtualization support not detected," even
though virtualization itself is fine.

---

## Setup steps

The tested sequence on a fresh machine. **Only step 1 needs an admin
PowerShell**; the rest runs as a normal user in the WSL distro.

### Step 1: Install WSL 2 + Ubuntu

Open PowerShell as Administrator (right-click → "Run as
administrator") and:

```powershell
wsl --install
```

This enables the required Windows features, installs **Ubuntu**, and
sets **WSL 2 as the default**. When the Linux shell comes up, leave it
with `exit`. If Windows asks for a restart, restart now.

### Step 2: Install Docker Desktop

In a **new, normal PowerShell** (no admin):

```powershell
winget install Docker.DockerDesktop --override "install --user --accept-license"
```

`--override "install --user --accept-license"` installs per-user (to
`%LOCALAPPDATA%\Programs\DockerDesktop`) without UAC/admin. Without the
flag, winget would take the all-users path and request admin.

Start Docker Desktop and wait until the whale icon stops animating.
You can skip the sign-in prompt.

### Step 3: Enable Docker Desktop's WSL integration

In Docker Desktop: **Settings → Resources → WSL Integration** → turn
on the toggle for **Ubuntu**, then Apply & Restart.

This makes the `docker` command available INSIDE the WSL distro,
talking to the same daemon as a Windows Docker would (which we don't
install at all).

> **Important:** Do **NOT** additionally run `apt install docker.io` or
> similar inside the WSL distro — that would be a second, competing
> Docker daemon. Docker Desktop + WSL integration is the only
> supported way.

### Step 4: Install Node + npm in WSL

From inside WSL Ubuntu:

```sh
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs npm
```

NodeSource provides a current Node version; installing `nodejs npm`
together makes sure both land on the Linux side (otherwise PATH interop
kicks in and serves the Windows npm from the Docker Desktop bundle,
which doesn't help us).

Verify:

```sh
which node && which npm
```

Both should point to `/usr/bin/...`, not `/mnt/c/...`.

### Step 5: Install Monoceros

From inside WSL Ubuntu, the same command as on native Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/getmonoceros/workbench/main/install.sh | bash
```

Verify:

```sh
monoceros --version
```

---

## Where to work? Tips for the WSL workflow

- **Windows Terminal with an Ubuntu profile** is the most natural
  entry point. By default Ubuntu starts in the Linux home (`~`), not in
  a `/mnt/c/...` Windows path. If you start WSL from PowerShell: use
  `wsl ~` instead of `wsl`, otherwise you land in the current
  PowerShell cwd.

- **VS Code with the WSL Remote extension** lets you work directly in
  the WSL filesystem and open dev containers in it.

- **Browser access** to container ports works without further
  configuration: Docker Desktop's WSL integration automatically mirrors
  ports bound from WSL onto the Windows loopback address, so
  `http://<container>.localhost/` URLs from Chrome/Edge/Firefox on
  Windows go straight to the WSL-side Traefik.

---

## Case: "Virtualization support not detected"

Symptom: Docker Desktop won't start and reports "Virtualization support
not detected" — **even though** virtualization is enabled in the BIOS
and `wsl --version` runs cleanly.

Cause: The WSL **platform** is installed, but there is **no WSL 2
distro**. `wsl --version` only shows the platform version, not whether
a distro is present. Docker Desktop's WSL 2 backend has no foundation
that way.

Check:

```powershell
wsl -l -v
```

If the list is empty or shows only a WSL 1 distro, that's the cause.
Fix it in a **PowerShell as Administrator:**

```powershell
wsl --set-default-version 2
wsl --update
wsl --install -d Ubuntu
```

Then **restart**, start Docker Desktop, and enable the distro under
**Settings → Resources → WSL Integration**.

> Don't bother looking for the "Use the WSL 2 based engine" switch in
> newer Docker Desktop versions — WSL 2 is the only backend there
> (Hyper-V isn't even available on Windows Home, among others). The
> switch is intentionally gone, not a bug.

---

## Case: no admin rights (managed/corporate laptop)

The per-user Docker install from step 2 needs no admin. But:

**Important catch:** `wsl --install` itself **needs admin**. So the
whole no-admin path only works if **WSL is already enabled** (e.g.
preinstalled by IT). If WSL isn't there at all and you have no admin,
there's no way around IT.

Limitations of Docker per-user mode:

- **WSL 2 backend only** (no Hyper-V) — exactly right for Monoceros
- **no Windows containers**

---

## Admin rights — what needs what?

| Command                                                             | Admin needed?  |
| ------------------------------------------------------------------- | -------------- |
| `wsl --install`                                                     | yes            |
| `wsl --update`                                                      | yes            |
| `wsl --set-default-version 2`                                       | recommended \* |
| `wsl --install -d Ubuntu`                                           | recommended \* |
| `winget install Docker.DockerDesktop --override "install --user …"` | no             |
| `sudo apt install -y nodejs npm` (inside WSL)                       | no \*\*        |
| Monoceros installer (`install.sh` inside WSL)                       | no             |

\* Not strictly required technically, but since the WSL setup block
runs in an admin PowerShell anyway, "everything as admin" is the simple
rule.

\*\* `sudo` in there is a WSL user permission, not Windows admin.

---

## Removing WSL completely

Everything in a **PowerShell as Administrator**, in this order:

```powershell
wsl --shutdown
wsl --unregister Ubuntu
wsl --uninstall
Disable-WindowsOptionalFeature -Online -FeatureName Microsoft-Windows-Subsystem-Linux
Disable-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform
```

Then **restart**. If `wsl -l -v` shows more than just "Ubuntu", run
`wsl --unregister <Name>` for each additional entry before you do
`wsl --uninstall`.

> `wsl --unregister` **irreversibly** deletes all of the distro's data.
> And: Docker Desktop runs on exactly these two features — disabling
> them also kills Docker Desktop's backend.

---

## References

- [Install Docker Desktop on Windows — Docker Docs](https://docs.docker.com/desktop/setup/install/windows-install/)
- [Understand permission requirements for Windows — Docker Docs](https://docs.docker.com/desktop/setup/install/windows-permission-requirements/)
- [How to install Linux on Windows with WSL — Microsoft Learn](https://learn.microsoft.com/en-us/windows/wsl/install)
- [`docker-on-linux.md`](docker-on-linux.md) — the counterpart for native Linux
