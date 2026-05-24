# `monoceros add-port`

Trägt einen oder mehrere Ports in die Container-Konfig ein.
Idempotent, zeigt vor dem Schreiben einen Diff.

```sh
monoceros add-port <name> [--yes] [--default] -- <port> [<port> …]
```

## Zweck

`add-port` schreibt den Port in die yml unter
`$MONOCEROS_HOME/container-configs/<name>.yml` **und** legt parallel
die Traefik-Dynamic-Config unter
`$MONOCEROS_HOME/traefik/dynamic/<name>.yml` ab. Der Singleton-Proxy
wird bei Bedarf hochgefahren (`ensureProxy()` — idempotent). Hot-
Reload: Traefik picks up die Datei innerhalb ~100 ms, **kein**
Container-Restart, **kein** Proxy-Restart. Siehe
[ADR 0007](../adr/0007-port-management-traefik.md).

## Mechanik

1. **Validierung**: jeder Port muss eine ganze Zahl zwischen `1` und
   `65535` sein. Tippfehler (Buchstaben, Floats, Werte außerhalb des
   Bereichs) werden mit dem konkreten Eingabewert zurückgewiesen.
2. **Dedup** auf CLI-Ebene: `add-port sandbox -- 3000 3000` wird zu
   `[3000]`.
3. **Diff-Vorschau** vor dem Schreiben (mit `--yes` übersprungen).
4. **AST-Mutation**: schreibt das `routing.ports`-Feld comment-
   preserving. Der `routing:`-Block wird beim ersten Aufruf angelegt
   (vorher ist er kommentiert im Init-Output enthalten). Existierende
   Einträge werden gegen Short-Form (`- 3000`) **und** Long-Form
   (`- port: 3000`) abgeglichen, damit Idempotenz egal ist welche
   Form der Builder von Hand verwendet hat.

Das resultierende yml-Layout:

```yaml
routing:
  ports:
    # erster Eintrag = <name>.localhost
    - 3000
    - 5173
  # default false; auf true setzen, um VS Code's eigene Forwards parallel
  # zu Traefik zu aktivieren
  vscodeAutoForward: false
```

## Argumente

| Argument           | Bedeutung                                          |
| ------------------ | -------------------------------------------------- |
| `<name>`           | Container-Name.                                    |
| `<port> [<port>…]` | Ein oder mehrere Ports nach `--`, jeweils 1–65535. |

## Optionen

| Option      | Bedeutung                                                                      |
| ----------- | ------------------------------------------------------------------------------ |
| `--yes, -y` | Diff-Confirm-Prompt überspringen (für Scripts).                                |
| `--default` | Genannten Port zum Default-Routen-Ziel machen (Position 0 in `routing.ports`). |

## Hostname-Schema

- `<container>.localhost` → Default-Port (erster Eintrag in
  `routing.ports`)
- `<container>-<port>.localhost` → expliziter interner Port

Wenn der Traefik-Host-Port über `monoceros-config.yml` von 80
abweicht (siehe `routing.hostPort`), wird er den URLs angehängt:
`http://<container>.localhost:<port>/`.

Beispiel: nach `monoceros add-port sandbox -- 3000 5173 6006`:

| URL                             | Routet auf                           |
| ------------------------------- | ------------------------------------ |
| `http://sandbox.localhost`      | `http://sandbox:3000` (Default-Port) |
| `http://sandbox-3000.localhost` | `http://sandbox:3000`                |
| `http://sandbox-5173.localhost` | `http://sandbox:5173`                |
| `http://sandbox-6006.localhost` | `http://sandbox:6006`                |

`*.localhost` löst per RFC 6761 auf jedem modernen OS automatisch auf
127.0.0.1 auf — kein `hosts`-File-Eingriff nötig.

## Default-Port wechseln

Der erste Eintrag in `routing.ports` doppelt sich als
`<container>.localhost`-Route. Um einen anderen Port zum Default zu
machen, ohne Liste neu aufzubauen:

```sh
monoceros add-port sandbox -y --default -- 5173
```

Wirkung:

- Port schon in der Liste → wird an Position 0 verschoben, restliche
  Reihenfolge bleibt erhalten
- Port noch nicht in der Liste → wird vorne eingefügt
- Port ist schon der Default → no-change

Mehr als ein Port mit `--default` ist ein Fehler — welcher von mehreren
soll Default sein? Bei Bedarf zwei Aufrufe: erst `--default`, dann der
Rest ohne Flag.

## Idempotenz

`add-port sandbox -- 3000` zweimal in Folge → der zweite Aufruf ist
ein no-change. `add-port sandbox -- 3000 5173` nach einem ersten
`add-port sandbox -- 3000` ergänzt nur den fehlenden Port 5173.

## Verwandte Befehle

- [`remove-port`](./remove-port.md) — Inverse
- [`monoceros apply <name>`](./apply.md) — refreshed beim nächsten
  Apply die Routes konsistent zur yml (zustands-driven)

## Fail-Modi

- **`Invalid port: <value>`** — Wert ist keine ganze Zahl oder liegt
  außerhalb 1–65535.
- **`No ports given`** — die Argumentliste nach `--` ist leer.
- **`No such config`** — Container-yml existiert nicht. `monoceros init`
  vorher.
