# `monoceros add-port`

Trägt einen oder mehrere Ports in die Container-Konfig ein.
Idempotent, zeigt vor dem Schreiben einen Diff.

```sh
monoceros add-port <name> [--yes] -- <port> [<port> …]
```

## Zweck

Im aktuellen Stand der Workbench (M5 Task 2, in Arbeit) **schreibt
add-port den Port in die yml** unter
`$MONOCEROS_HOME/container-configs/<name>.yml`. Die eigentliche
Erreichbarkeit vom Host über Traefik wird in den Folge-Schritten von
M5 Task 2 verdrahtet (siehe
[ADR 0007](../adr/0007-port-management-traefik.md)) — sobald die
Traefik-Singleton-Mechanik landet, wirkt `add-port` on-the-fly ohne
Container-Restart und legt zusätzlich die Dynamic-Config für Traefik
ab.

## Mechanik

1. **Validierung**: jeder Port muss eine ganze Zahl zwischen `1` und
   `65535` sein. Tippfehler (Buchstaben, Floats, Werte außerhalb des
   Bereichs) werden mit dem konkreten Eingabewert zurückgewiesen.
2. **Dedup** auf CLI-Ebene: `add-port sandbox -- 3000 3000` wird zu
   `[3000]`.
3. **Diff-Vorschau** vor dem Schreiben (mit `--yes` übersprungen).
4. **AST-Mutation**: schreibt das `ports:`-Feld comment-preserving.
   Existierende Einträge werden gegen Short-Form (`- 3000`) **und**
   Long-Form (`- port: 3000`) abgeglichen, damit Idempotenz egal
   ist welche Form der Builder von Hand verwendet hat.

## Argumente

| Argument           | Bedeutung                                          |
| ------------------ | -------------------------------------------------- |
| `<name>`           | Container-Name.                                    |
| `<port> [<port>…]` | Ein oder mehrere Ports nach `--`, jeweils 1–65535. |

## Optionen

| Option      | Bedeutung                                       |
| ----------- | ----------------------------------------------- |
| `--yes, -y` | Diff-Confirm-Prompt überspringen (für Scripts). |

## Hostname-Schema (für die Traefik-Integration)

Sobald die Traefik-Mechanik live ist, gilt:

- `<container>.localhost` → Default-Port (erster Eintrag in `ports:`)
- `<container>-<port>.localhost` → expliziter interner Port

Beispiel: nach `monoceros add-port sandbox -- 3000 5173 6006`:

| URL                             | Routet auf                           |
| ------------------------------- | ------------------------------------ |
| `http://sandbox.localhost`      | `http://sandbox:3000` (Default-Port) |
| `http://sandbox-3000.localhost` | `http://sandbox:3000`                |
| `http://sandbox-5173.localhost` | `http://sandbox:5173`                |
| `http://sandbox-6006.localhost` | `http://sandbox:6006`                |

`*.localhost` löst per RFC 6761 auf jedem modernen OS automatisch auf
127.0.0.1 auf — kein `hosts`-File-Eingriff nötig.

## Idempotenz

`add-port sandbox -- 3000` zweimal in Folge → der zweite Aufruf ist
ein no-change. `add-port sandbox -- 3000 5173` nach einem ersten
`add-port sandbox -- 3000` ergänzt nur den fehlenden Port 5173.

## Verwandte Befehle

- [`remove-port`](./remove-port.md) — Inverse
- [`monoceros apply <name>`](./apply.md) — Änderung wirksam machen
  (bis die Hot-Reload-Mechanik landet)

## Fail-Modi

- **`Invalid port: <value>`** — Wert ist keine ganze Zahl oder liegt
  außerhalb 1–65535.
- **`No ports given`** — die Argumentliste nach `--` ist leer.
- **`No such config`** — Container-yml existiert nicht. `monoceros init`
  vorher.
