# `monoceros completion <shell>`

Druckt ein Shell-Completion-Skript nach stdout. Unterstützt sind
**bash**, **zsh** und **pwsh** (PowerShell).

In aller Regel musst du diesen Befehl nicht von Hand aufrufen: das
[`install.sh`](../../install.sh) bzw.
[`install.ps1`](../../install.ps1) im Workbench-Root erledigt die
Completion-Einrichtung automatisch beim Setup. Manueller Aufruf nur,
wenn du die Einrichtung neu anstoßen oder in ein anderes Verzeichnis
schreiben willst.

```sh
monoceros completion zsh  > "${fpath[1]}/_monoceros"        # zsh
monoceros completion bash > ~/.bash_completion.d/monoceros  # bash
```

```powershell
# PowerShell
monoceros completion pwsh > $HOME\.config\monoceros\completion.ps1
Add-Content $PROFILE ". $HOME\.config\monoceros\completion.ps1"
```

## Architektur — dünner Wrapper + CLI-Engine

Das gedruckte Skript ist ein **dünner Wrapper**. Die eigentliche
Completion-Logik lebt in der CLI selbst hinter dem internen Befehl
`monoceros __complete --line "<buffer>" --point <N>`. Der Wrapper
macht nur:

1. Die aktuelle Eingabezeile + Cursor-Position aus den Shell-Variablen
   abgreifen (`COMP_LINE`/`COMP_POINT` in bash, `BUFFER`/`CURSOR` in
   zsh, der AST-Extent in pwsh).
2. Beides an `monoceros __complete` durchreichen.
3. Die zurückkommenden Kandidaten (eine pro Zeile) an den Completion-
   Mechanismus der Shell geben.

Konsequenz: das Wrapper-Skript enthält **keine** hartkodierte
Befehlsliste mehr. Die Quelle der Wahrheit ist die CLI. Ein
Workbench-Update bringt neue Befehle / Flags / Werte automatisch in
die Completion — ohne dass das Wrapper-Skript neu generiert werden
muss (siehe „Re-generieren" unten).

## Was completiert wird

- **Befehlsname** (Position 1) — alle Subcommands (`init`, `apply`,
  `add-feature`, …), prefix-gefiltert gegen das, was schon getippt
  ist.
- **Container-Name** — bei Befehlen, die einen existierenden Container
  erwarten (`apply`, `shell`, `run`, `logs`, `start`, `stop`,
  `status`, `remove`, alle `add-*`/`remove-*`-Editoren): die Namen aus
  `$MONOCEROS_HOME/container-configs/*.yml`.
- **Flag-Namen** — pro Befehl die akzeptierten Flags, sobald du mit
  `-` anfängst. Boolean-Flags (`--yes`/`-y`, `--default`, `--no-backup`)
  kommen ohne `=`, Value-Flags (`--with`, `--with-repo`, `--with-ports`,
  `--path`, `--provider`, …) kommen **mit** Trailing-`=`, damit die
  Shell kein Auto-Space dahinter setzt (sonst entstünde
  `--with-ports =3000`).
- **Flag-Werte** —
  - `monoceros init <name> --with=<TAB>` → der Komponenten-Katalog
    (Sprachen, Services, Features inkl. Sub-Components wie
    `atlassian/twg`).
  - Komma-getrennte Listen: `--with=node,<TAB>` schlägt die nächsten
    Werte vor und hängt sie hinter das Komma.
  - `monoceros add-repo <name> <url> --provider=<TAB>` → `github`,
    `gitlab`, `bitbucket`, `gitea`.
- **Feature-Kurznamen** — `monoceros add-feature <name> <TAB>` /
  `remove-feature <name> <TAB>` → die Feature-Komponenten aus dem
  Katalog (`atlassian`, `atlassian/twg`, `claude`, `github`).
- **Feature-Options nach `--`** —
  `monoceros add-feature <name> <feature> -- <TAB>` → die Option-Keys
  aus dem Feature-Manifest. Bei `key=<TAB>` für Boolean-Optionen:
  `key=true` / `key=false`. Bereits gesetzte Keys fallen aus der
  Vorschlagsliste.
- **`monoceros completion <TAB>`** → `bash`, `zsh`, `pwsh`.

Nicht completiert: `init <NAME>` (frischer Name — Vorschläge aus
existierenden Configs würden zu Kollisionen einladen), `restore <PATH>`
(Backup-Pfad — Freiform), `--with-repo`/`--with-ports`-Werte (URLs
und freie Portnummern — kein sinnvoller Kandidatenpool).

## Container-Namen-Quelle

Der Engine liest das `MONOCEROS_HOME`-Env wenn gesetzt, sonst fällt
sie auf `$HOME/.monoceros` zurück — identisch zur Resolution der CLI
selbst. Wer im Workbench-Checkout entwickelt und auch dort
Container-Namen completed haben will, setzt sich
`MONOCEROS_HOME="$PWD/.local"` in der Shell.

## Installation — bash

```sh
mkdir -p ~/.bash_completion.d
monoceros completion bash > ~/.bash_completion.d/monoceros
echo 'source ~/.bash_completion.d/monoceros' >> ~/.bashrc
# neues Terminal öffnen, oder: source ~/.bashrc
```

Wenn dein System bereits `bash-completion` als Paket installiert hat
(typisch unter Homebrew / Debian), schreib das Skript einfach in das
von `bash-completion` durchgesuchte Verzeichnis.

Bash-Eigenheit: bei mehreren Kandidaten mit gemeinsamem Präfix
completed das erste Tab nur bis zum Präfix und zeigt erst das zweite
Tab die volle Liste. Wer das erste Tab direkt listen lassen will,
setzt einmalig in `~/.bashrc`:

```sh
bind 'set show-all-if-ambiguous on'
```

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
#   zstyle ':completion:*' menu select
#   unsetopt LIST_AMBIGUOUS
```

Die letzten zwei Zeilen sind das zsh-Pendant zu bash's
`show-all-if-ambiguous`: `unsetopt LIST_AMBIGUOUS` lässt das erste Tab
direkt die Kandidatenliste zeigen statt nur den gemeinsamen Präfix
einzufügen, `menu select` schaltet Pfeiltasten-Navigation im Menü
frei. `install.sh` schreibt beide Zeilen bei der zsh-Einrichtung
automatisch mit.

Neues Terminal, `monoceros <TAB>` zeigt die Subcommands. `monoceros
apply <TAB>` zeigt deine Container-Namen.

## Re-generieren nach Updates

Weil der Wrapper dünn ist und die Logik in der CLI lebt, musst du das
Skript nach einem Workbench-Update **normalerweise nicht** neu
generieren — neue Befehle / Flags / Werte tauchen automatisch auf,
sobald die aktualisierte CLI auf dem `$PATH` liegt.

Neu schreiben musst du nur, wenn sich die **Wrapper-Mechanik** selbst
ändert (selten — z. B. eine neue Shell-Integration). `install.sh` /
`install.ps1` regenerieren das Wrapper-Skript bei jedem Lauf, also ist
ein erneuter Install-Durchlauf der dokumentierte Weg, falls doch nötig.

## Verwandte Befehle

- [`list-components`](./list-components.md) — listet die Komponenten,
  die `init --with=…` und `add-feature` verstehen. Diese Komponenten
  werden via Tab vervollständigt (siehe „Was completiert wird").
