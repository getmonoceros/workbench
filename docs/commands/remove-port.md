# `monoceros remove-port`

Entfernt einen oder mehrere Ports aus der Container-Konfig. Idempotent,
zeigt vor dem Schreiben einen Diff.

```sh
monoceros remove-port <name> [--yes] -- <port> [<port> …]
```

## Zweck

Spiegelbild zu [`add-port`](./add-port.md). Entfernt die genannten
Einträge aus dem `ports:`-Block der Container-yml. Sobald die
Traefik-Mechanik live ist (M5 Task 2), räumt `remove-port` zusätzlich
die Dynamic-Config-Datei für den Port weg, und beim letzten verbleibenden
Port stoppt Monoceros den Traefik-Singleton (siehe
[ADR 0007](../adr/0007-port-management-traefik.md)).

## Mechanik

1. **Validierung** wie bei `add-port` (ganze Zahl 1–65535).
2. **Matching** gegen Short- und Long-Form: `remove-port sandbox -- 9229`
   entfernt sowohl einen Eintrag `- 9229` als auch `- port: 9229`.
3. **Diff-Vorschau** vor dem Schreiben (mit `--yes` übersprungen).
4. **AST-Mutation**: entfernt die Einträge comment-preserving. Wenn
   die Liste danach leer ist, wird der `ports:`-Schlüssel ganz
   gepruned.

## Argumente

| Argument           | Bedeutung                                          |
| ------------------ | -------------------------------------------------- |
| `<name>`           | Container-Name.                                    |
| `<port> [<port>…]` | Ein oder mehrere Ports nach `--`, jeweils 1–65535. |

## Optionen

| Option      | Bedeutung                                       |
| ----------- | ----------------------------------------------- |
| `--yes, -y` | Diff-Confirm-Prompt überspringen (für Scripts). |

## Idempotenz

Ports, die gar nicht in der yml stehen, werden schweigend übergangen
(no-change). Das macht `remove-port` in Scripts robust gegen den
„Hab ich den Port schon mal entfernt?"-Fall.

## Verwandte Befehle

- [`add-port`](./add-port.md) — Inverse
- [`monoceros apply <name>`](./apply.md) — Änderung wirksam machen

## Fail-Modi

- **`Invalid port: <value>`** — Wert ist keine ganze Zahl oder liegt
  außerhalb 1–65535.
- **`No ports given`** — die Argumentliste nach `--` ist leer.
- **`No such config`** — Container-yml existiert nicht.
