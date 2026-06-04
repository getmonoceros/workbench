# `monoceros completion <shell>`

Prints a shell completion script to stdout. Supported shells are
**bash**, **zsh**, and **pwsh** (PowerShell).

As a rule you won't need to call this command by hand: the
[`install.sh`](../../install.sh) and
[`install.ps1`](../../install.ps1) scripts in the workbench root set up
completion automatically during setup. Run it manually only if you want
to re-trigger the setup or write to a different directory.

```sh
monoceros completion zsh  > "${fpath[1]}/_monoceros"        # zsh
monoceros completion bash > ~/.bash_completion.d/monoceros  # bash
```

```powershell
# PowerShell
monoceros completion pwsh > $HOME\.config\monoceros\completion.ps1
Add-Content $PROFILE ". $HOME\.config\monoceros\completion.ps1"
```

## Architecture — thin wrapper + CLI engine

The printed script is a **thin wrapper**. The actual completion logic
lives in the CLI itself, behind the internal command
`monoceros __complete --line "<buffer>" --point <N>`. The wrapper only
does the following:

1. Grab the current input line and cursor position from the shell
   variables (`COMP_LINE`/`COMP_POINT` in bash, `BUFFER`/`CURSOR` in
   zsh, the AST extent in pwsh).
2. Pass both to `monoceros __complete`.
3. Hand the returned candidates (one per line) to the shell's
   completion mechanism.

Consequence: the wrapper script no longer contains **any** hard-coded
command list. The source of truth is the CLI. A workbench update brings
new commands / flags / values into completion automatically — without
the wrapper script having to be regenerated (see "Regenerating" below).

## What gets completed

- **Command name** (position 1) — all subcommands (`init`, `apply`,
  `add-feature`, …), prefix-filtered against what has already been
  typed.
- **Container name** — for commands that expect an existing container
  (`apply`, `shell`, `run`, `logs`, `start`, `stop`, `status`,
  `remove`, all `add-*`/`remove-*` editors): the names from
  `$MONOCEROS_HOME/container-configs/*.yml`.
- **Flag names** — per command, the accepted flags, as soon as you
  start with `-`. Boolean flags (`--yes`/`-y`, `--default`,
  `--no-backup`) come without `=`; value flags (`--with-languages`,
  `--with-features`, `--with-services`, `--with-repo`, `--with-ports`,
  `--path`, `--provider`, …) come **with** a trailing `=`, so the shell
  doesn't insert an auto-space after them (otherwise you'd get
  `--with-ports =3000`).
- **Flag values** —
  - `monoceros init <name> --with-languages=<TAB>` →
    `monoceros init <name> --with-features=<TAB>` →
    `monoceros init <name> --with-services=<TAB>` → the component
    catalog (languages, services, features including sub-components
    like `atlassian/twg`).
  - Comma-separated lists: `--with-languages=node,<TAB>` suggests the
    next values and appends them after the comma.
  - `monoceros add-repo <name> <url> --provider=<TAB>` → `github`,
    `gitlab`, `bitbucket`, `gitea`.
- **Feature short names** — `monoceros add-feature <name> <TAB>` /
  `remove-feature <name> <TAB>` → the feature components from the
  catalog (`atlassian`, `atlassian/twg`, `claude`, `github`).
- **Feature options after `--`** —
  `monoceros add-feature <name> <feature> -- <TAB>` → the option keys
  from the feature manifest. For `key=<TAB>` on boolean options:
  `key=true` / `key=false`. Keys that are already set drop out of the
  suggestion list.
- **`monoceros completion <TAB>`** → `bash`, `zsh`, `pwsh`.

Not completed: `init <NAME>` (a fresh name — suggesting from existing
configs would invite collisions), `restore <PATH>` (backup path — free
form), `--with-repo`/`--with-ports` values (URLs and arbitrary port
numbers — no meaningful candidate pool).

## Container-name source

The engine reads the `MONOCEROS_HOME` env var if set, otherwise it
falls back to `$HOME/.monoceros` — identical to the CLI's own
resolution. If you develop inside the workbench checkout and want
container-name completion there too, set
`MONOCEROS_HOME="$PWD/.local"` in your shell.

## Installation — bash

```sh
mkdir -p ~/.bash_completion.d
monoceros completion bash > ~/.bash_completion.d/monoceros
echo 'source ~/.bash_completion.d/monoceros' >> ~/.bashrc
# open a new terminal, or: source ~/.bashrc
```

If your system already has `bash-completion` installed as a package
(typical under Homebrew / Debian), just write the script into the
directory that `bash-completion` scans.

bash quirk: with multiple candidates that share a common prefix, the
first Tab only completes up to the prefix and only the second Tab shows
the full list. If you want the first Tab to list directly, set this
once in `~/.bashrc`:

```sh
bind 'set show-all-if-ambiguous on'
```

## Installation — zsh

`zsh` loads completion files named `_<command>` automatically, as long
as their directory is on `$fpath` and `compinit` has been called.

```sh
# if you have Oh My Zsh, ~/.oh-my-zsh/completions is on the fpath:
monoceros completion zsh > ~/.oh-my-zsh/completions/_monoceros

# vanilla zsh:
mkdir -p ~/.zsh/completions
monoceros completion zsh > ~/.zsh/completions/_monoceros
# add once to ~/.zshrc:
#   fpath=(~/.zsh/completions $fpath)
#   autoload -Uz compinit && compinit
#   zstyle ':completion:*' menu select
#   unsetopt LIST_AMBIGUOUS
```

The last two lines are the zsh counterpart to bash's
`show-all-if-ambiguous`: `unsetopt LIST_AMBIGUOUS` makes the first Tab
show the candidate list directly instead of just inserting the common
prefix, and `menu select` enables arrow-key navigation in the menu.
`install.sh` writes both lines automatically during zsh setup.

New terminal, `monoceros <TAB>` shows the subcommands. `monoceros
apply <TAB>` shows your container names.

## Regenerating after updates

Because the wrapper is thin and the logic lives in the CLI, you
**normally don't** need to regenerate the script after a workbench
update — new commands / flags / values show up automatically as soon as
the updated CLI is on `$PATH`.

You only need to rewrite it if the **wrapper mechanics** themselves
change (rare — e.g. a new shell integration). `install.sh` /
`install.ps1` regenerate the wrapper script on every run, so re-running
the installer is the documented way if it ever is necessary.

## Related commands

- [`list-components`](./list-components.md) — lists the components that
  `init --with-languages=…` / `--with-features=…` / `--with-services=…`
  and `add-feature` understand. These components are completed via Tab
  (see "What gets completed").
