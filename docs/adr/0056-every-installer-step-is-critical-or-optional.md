# ADR 0056: Every installer step is critical or optional, and the home is seeded first

- Status: accepted
- Date: 2026-09-17
- Relates to: [ADR 0005](0005-cli-distribution-via-npm.md) (npm as the
  distribution channel, and the assumption that npm puts the shim on PATH),
  [ADR 0031](0031-pat-based-repo-auth.md) (the global `monoceros-config.env`
  the installer seeds)

## Context

`installer/install.sh` grew by accretion over a year. Every step arrived with
whatever error handling looked reasonable at the time, and four different
answers to the same question ended up side by side in one 733-line script: the
npm install called `fail` and exited, a missing config template warned and
carried on, the binary lookup swallowed its failure with `|| true` and then
printed a green check anyway, and the shell-completion step had no handling at
all, so a failure there killed the script through `set -e` without printing a
word.

Nothing enforced a choice between them because nothing ever ran the script. The
e2e suite installs with `npm install -g` directly and says so in a comment, so
the script every builder runs first went 58 releases without being executed
outside a maintainer's machine.

A builder found the gap. `monoceros completion zsh` could not resolve the
freshly installed binary, the script died silently in the completion step, and
the two config templates in the step after it were never copied. The CLI worked,
`monoceros init` created `~/.monoceros` on its own, and the home looked healthy
while the file the CLI's own error messages point at by name did not exist.

Ordering made it worse than it had to be. Shell completion, which any builder
can regenerate with one command, sat in front of the config templates, which
they cannot write from memory.

## Decision

**Every step in the installer is either critical or optional, and there is no
third variant.**

- **Critical** means the builder ends up with a broken install, or without
  something they cannot reconstruct on their own. The step calls `abort`, which
  names the step and the reason and exits non-zero. Prerequisites, the npm
  install, a runnable CLI afterwards, and the two config templates are critical.
- **Optional** means convenience they can add later. The step warns and the
  install continues. Shell completion and the PATH rc-file append are optional.

Two things follow from the contract:

**The home is seeded before shell completion**, directly after the npm install.
The order of steps is the order of what a builder cannot recover, not the order
the steps were written in.

**Seeding does not depend on resolving the installed binary.** The installer
computes where npm put the package from the prefix it already holds, so the
config templates land whether or not `monoceros` is on PATH. A step that cannot
fail must not sit behind one that can.

An `ERR` trap is the backstop. Any unguarded failure still names the step it
died in, instead of ending the output mid-sentence.

**The contract is enforced by a test that runs the installer.**
`installer/test/install-matrix.sh` executes `install.sh` in containers across
the Node setups builders have: a writable prefix on PATH, a writable prefix that
is not on PATH, a system-wide Node as an ordinary user, and a run where
completion cannot be written. Each case asserts the exit code, both config files
and a usable `monoceros` command. It is a `workflow_call` gate that
`release-cli.yml` needs, alongside precheck and e2e.

## Consequences

- A missing template in the npm package now fails the install loudly instead of
  being skipped with a warning. That is the point: the builder finds out at
  install time rather than when a token does not work.
- The installer takes responsibility for its own promise. If npm's prefix is
  writable but not on PATH, it puts the bin directory on PATH and persists it,
  rather than reporting success for a CLI that is not a command. Previously only
  the unwritable-prefix branch did this.
- `install.sh` carries a `MONOCEROS_TEST_PACKAGE` seam so CI can point it at a
  tarball packed from the working tree. A release is gated on the artifact about
  to be published, which also covers the templates actually being in it.
- `install.ps1` already had the contract in a different shape: `Invoke-Step`
  names each step and a `throw` aborts the run, and step 4 asserts both config
  files landed in the distro. It stays as it is.
- New steps have to pick a side. That is a small ongoing cost and the only thing
  that keeps the script from drifting back into four answers.

## Non-goals

- **Always installing into our own prefix.** Forcing a fixed prefix regardless
  of what npm is configured with would make the install location certain, but it
  moves the CLI for every existing nvm, fnm, volta and Homebrew user and leaves
  two copies behind on the next update. That needs a migration path and is its
  own decision.
- **Making the installer install Node or Docker.** Unchanged from the script's
  original scope.
