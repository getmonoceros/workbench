# `monoceros shell`

Öffnet eine interaktive Bash-Sitzung im benannten Container. Bringt
ihn vorher automatisch hoch falls nötig.

```sh
monoceros shell <name>
```

## Zweck

Der Standard-Weg um „im Container zu sein": direkter Bash-Prompt
mit allen Tools, Features und Auth-States, die `monoceros apply`
materialisiert hat. Beendet sich mit `exit` oder `Ctrl-D`.

## Mechanik

1. **Container-Check**: prüft, ob `<MONOCEROS_HOME>/container/<name>/.devcontainer/`
   existiert. Wenn nicht → `Run \`monoceros apply <name>\` first`-Fehler.
2. **Implizites Hochfahren**: `devcontainer up` läuft quiet (Output
   wird nur bei Fehler ausgegeben). Wenn der Container schon läuft,
   ist das ein no-op.
3. **Exec**: `devcontainer exec … bash` startet eine interaktive
   Bash-Sitzung. stdio wird direkt durchgereicht (kein Masking,
   kein Buffering), sodass eine echte TTY hängt und Bash sich
   interaktiv verhält.

Der Exit-Code der Bash-Sitzung wird zurückpropagiert.

## Argumente

| Argument | Bedeutung                                                                                                    |
| -------- | ------------------------------------------------------------------------------------------------------------ |
| `<name>` | Container-Name. Muss eine yml unter `container-configs/` und ein materialisiertes `container/<name>/` haben. |

## Beispiel

```sh
$ monoceros shell sandbox
node ➜ /workspaces/sandbox $ ls projects/
api  web

node ➜ /workspaces/sandbox $ exit
$
```

Auf macOS/Windows mit Docker Desktop: das Bind-Mount-Volume zum
Workspace-Ordner braucht beim ersten Aufruf ggf. ein paar Sekunden
für die File-Sharing-Negotiation; danach fühlt es sich nativ an.

## Verwandte Befehle

- [`monoceros run <name> -- <cmd>`](./run.md) — One-off-Befehl statt
  interaktive Sitzung
- [`monoceros apply <name>`](./apply.md) — Container bauen + hochfahren
- [`monoceros stop <name>`](./stop.md) — Compose-Services pausieren

## Fail-Modi

- **`No .devcontainer/ at <path>`** — Container nie materialisiert.
  `monoceros apply <name>` vorher.
- **Container started nicht** — die ersten paar Zeilen aus dem
  buffered `up`-Output werden bei Fehler an stderr geschickt.
  Häufige Ursachen: Docker Desktop nicht laufend, Port-Konflikt,
  Image-Build-Fehler bei geänderten Features.
- **Sofortiges Exit ohne Fehlermeldung** — Bash sieht kein TTY.
  Das passiert wenn die CLI nicht über ein Terminal aufgerufen
  wird (z.B. aus einem nicht-interaktiven Shell-Script). Lösung:
  `monoceros run <name> -- <cmd>` für scripted Aufrufe nutzen.
