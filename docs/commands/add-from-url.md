# `monoceros add-from-url`

Adds an HTTPS install-script URL that is executed via
`curl -fsSL <url> | sh` on every container rebuild.

## Purpose

Some tools have neither a devcontainer feature nor an apt package and
are instead installed via a project-specific install-script URL.
Examples:

- `curl -fsSL https://teamwork-graph.atlassian.com/cli/install | sh` (TWG CLI)
- `curl -fsSL https://starship.rs/install.sh | sh` (Starship prompt)
- `curl -fsSL https://sh.rustup.rs | sh` (Rust toolchain)

`add-from-url` provisions the solution with such installs
declaratively: add it once, and the script then runs automatically on
every `monoceros apply` and on any other machine that picks up the
solution.

## ⚠️ Security implications

This is **remote code execution on every container creation, by
design.** The maintainer of the URL can change the script tomorrow and
your container will run the new payload without you seeing the diff.
This is often acceptable in the solution-builder context (the tool
maintainer is trusted, the URL is part of an established workflow), but
it is not an automatic default.

For this reason the command **always** prints a loud security warning
before the confirm. `--yes` skips _both_ — the warning and the diff —
so use it only in scripts where the URL has already been audited.

Reach for `add-apt-packages` or `add-feature` first whenever possible:
packages and devcontainer features come from signed, versioned
sources.

## Synopsis

```sh
monoceros add-from-url <containername> <url> [--yes]
```

## Options

| Flag           | Meaning                                                                      |
| -------------- | ---------------------------------------------------------------------------- |
| `--yes` / `-y` | Skip _both_ the security warning and the diff confirm. Audited scripts only. |

## Mechanics

1. The URL is added to `installUrls:` in the container yml (order is
   preserved — installs can build on each other). Comments in the yml
   are left untouched.
2. On the next `monoceros apply <containername>`,
   `.devcontainer/post-create.sh` is regenerated. The following is
   appended at the end:

   ```bash
   echo "→ Running N install URL(s) added via add-from-url…"
   echo "→ https://example.com/install"
   curl -fsSL "https://example.com/install" | sh
   ```

   Why `sh` and not `bash`? Most install scripts (rustup, starship,
   homebrew, …) target POSIX `sh`, and some explicitly refuse to run
   under `bash` (starship). `sh` is the more universal default. The
   outer post-create.sh still runs under bash with `set -o pipefail`,
   so a failure in curl _or_ in the install script aborts the
   post-create step.

3. On the next `monoceros apply`, the container runs the script.

`monoceros down` and new builds re-run the scripts again. When a script
runs a second time and tools are already installed, they should handle
that idempotently — how the script behaves in that case is up to the
maintainer of the URL.

## Validation

Allowed: `^https:\/\/[A-Za-z0-9.\-_~/:?#[\]@!&'()*+,;=%]+$`

Specifically:

- **HTTPS only** (no `http://`, no `file://`, no `ssh://`)
- No shell metacharacters (`$`, backtick, `;`, `|`, `&`, etc.) — the URL is embedded into post-create.sh via variable quoting, but the validation is belt-and-suspenders.

## Idempotency

Adding the same URL a second time → "No changes — solution is already
in the desired state.", exit 0, no file change.

Adding multiple URLs → accumulated in the order given.

## Examples

Add a single URL:

```sh
monoceros add-from-url sandbox https://teamwork-graph.atlassian.com/cli/install
# … read the security warning … y to confirm
monoceros apply sandbox
monoceros run sandbox -- twg --version
```

Multiple installs, where the second builds on the first:

```sh
monoceros add-from-url sandbox https://example.com/install-base
monoceros add-from-url sandbox https://example.com/install-extras   # runs AFTER install-base
monoceros apply sandbox
```

In a script (URL is audited):

```sh
monoceros add-from-url sandbox --yes https://my-trusted-cdn.com/install
monoceros apply sandbox
```

## Related commands

- `monoceros add-apt-packages <name>` — prefer this when the tool is in the distro repos
- `monoceros add-feature <name>` — prefer this when a devcontainer feature exists
- `monoceros remove-from-url <name> <url>` — the inverse
- `monoceros apply <name>` — rebuild the container so the URL is actually fetched + executed

## Failure modes

- **`Invalid install URL`** — the URL does not match the allowed
  pattern. Common causes: `http://` instead of `https://`, spaces,
  special characters outside the URL-safe set (e.g. an unencoded `<`).
- **`Missing URL`** — no argument passed.
- **Container build fails in the URL section** — the remote script
  itself has an error, or the URL is unreachable. To diagnose, check
  the URL manually with `curl -fsSL <url> | less` on the host or in a
  throwaway shell. If the URL is temporarily down:
  `monoceros remove-from-url <name> <url>` and apply again.
