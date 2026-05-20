# `monoceros completion <shell>`

Druckt ein Shell-Completion-Skript nach stdout. Unterstützt sind
**bash** und **zsh**.

```sh
monoceros completion zsh > "${fpath[1]}/_monoceros"
# oder
monoceros completion bash > ~/.bash_completion.d/monoceros
```

## Was completiert wird

- **Position 1**: alle Subcommands (`init`, `apply`, `shell`, …)
- **Position 2**: bei Befehlen, die einen existierenden Container
  erwarten (`apply`, `shell`, `run`, `logs`, `start`, `stop`,
  `status`, `remove`, alle `add-*`/`remove-*`-Editoren), werden die
  Container-Namen aus `$MONOCEROS_HOME/container-configs/*.yml`
  vorgeschlagen
- **`monoceros completion <TAB>`**: schlägt `bash` und `zsh` vor

Nicht completiert: `init <NAME>` (frischer Name), `restore <PATH>`
(Backup-Pfad), Flags hinter dem ersten positional. Das sind
Eingaben, für die kein sinnvoller Kandidaten-Pool existiert.

## Container-Namen-Quelle

Die Skripte lesen das `MONOCEROS_HOME`-Env wenn gesetzt, sonst
fallen sie auf `$HOME/.monoceros` zurück — identisch zur Resolution
der CLI selbst. Wer im Workbench-Checkout entwickelt und auch dort
Container-Namen completed haben will, setzt sich
`MONOCEROS_HOME="$PWD/.local"` in der Shell.

## Installation — bash

```sh
mkdir -p ~/.bash_completion.d
monoceros completion bash > ~/.bash_completion.d/monoceros
echo 'source ~/.bash_completion.d/monoceros' >> ~/.bashrc
# neues Terminal öffnen, oder: source ~/.bashrc
```

Wenn dein System bereits `bash-completion` als Paket installiert
hat (typisch unter Homebrew / Debian), schreib das Skript einfach
in das von `bash-completion` durchgesuchte Verzeichnis (`brew
--prefix`/etc/bash_completion.d auf macOS, `/etc/bash_completion.d`
auf Linux).

## Installation — zsh

`zsh` lädt Completion-Files namens `_<command>` automatisch, sofern
ihr Verzeichnis im `$fpath` steht und `compinit` aufgerufen wurde.

```sh
# wenn du Oh-My-Zsh hast, ist ~/.oh-my-zsh/completions im fpath:
monoceros completion zsh > ~/.oh-my-zsh/completions/_monoceros

# vanille-zsh:
mkdir -p ~/.zsh/completions
monoceros completion zsh > ~/.zsh/completions/_monoceros
# einmalig in ~/.zshrc ergänzen:
#   fpath=(~/.zsh/completions $fpath)
#   autoload -Uz compinit && compinit
```

Neues Terminal, `monoceros <TAB>` zeigt die Subcommands. `monoceros
apply <TAB>` zeigt deine Container-Namen.

## Re-generieren nach Updates

Die statische Subcommand-Liste im Skript stammt aus dem Stand zum
Zeitpunkt der Generierung. Nach `npm update -g
@getmonoceros/workbench` einmal neu schreiben:

```sh
monoceros completion zsh > "${fpath[1]}/_monoceros"
```

Wenn ein neuer Subcommand auftaucht und du das Skript nicht
neugeneriert hast, fällt der Tab nur stumm aus — kein Bruch, einfach
keine Vervollständigung für den neuen Befehl.

## Verwandte Befehle

- [`list-components`](./list-components.md) — listet die Komponenten,
  die `init --with=…` versteht. Komponenten werden derzeit nicht via
  Tab vervollständigt (bewusste Auslassung — `--with=` ist
  Komma-getrennt, eigenes Parsing fällig).
