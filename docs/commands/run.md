# `monoceros run`

Führt einen einmaligen Befehl im benannten Container aus und gibt
dessen Exit-Code zurück. Bringt den Container vorher automatisch
hoch falls nötig.

```sh
monoceros run <name> -- <cmd> [args …]
```

## Zweck

Für alles was kein interaktives Bash braucht: Build-Skripte,
einzelne CLI-Aufrufe, Health-Checks. Im Gegensatz zu
`monoceros shell` ist der Container danach wieder bei sich selbst,
ohne hängende Sitzung.

Häufige Anwendungsfälle:

- `monoceros run sandbox -- pnpm test`
- `monoceros run sandbox -- gh pr create`
- `monoceros run sandbox -- claude` (interaktiv möglich; siehe
  „Interaktive Inner-Befehle" unten)

## Mechanik

1. **Container-Check**: wie bei `shell`. Wenn `.devcontainer/`
   nicht existiert → `Run \`monoceros apply <name>\` first`-Fehler.
2. **Implizites Hochfahren**: `devcontainer up` quiet (no-op wenn
   schon läuft).
3. **Exec**: `devcontainer exec --workspace-folder … <cmd> [args]`.
   stdio inherit, sodass der innere Befehl direkten TTY-Zugriff hat.
   Exit-Code wird zurückpropagiert.

## Argumente

| Argument   | Bedeutung                                                                                                                                             |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<name>`   | Container-Name.                                                                                                                                       |
| `-- <cmd>` | Alles nach `--` ist der innere Befehl + seine Argumente. `--` ist nötig, damit Monoceros nicht versucht, Flags wie `--help` selbst zu interpretieren. |

## Beispiele

Einfach:

```sh
$ monoceros run sandbox -- pnpm test
> @your-org/api@1.0.0 test
> vitest run
…
```

Mit eigenen Flags:

```sh
$ monoceros run sandbox -- gh pr list --state open
```

## Interaktive Inner-Befehle

`monoceros run` läuft mit `stdio: 'inherit'` und reicht dadurch ein
echtes TTY weiter. Interaktive Inner-Befehle wie `claude`, `acli
rovodev run`, `psql` funktionieren genauso wie in einer
`monoceros shell`-Sitzung. Beenden mit dem inneren Befehl beendet
auch den `run`-Aufruf.

## Shell-Builtins (`cd`, `export`, ...)

`monoceros run` reicht das Argument-Array verbatim an
`docker exec` weiter — ohne Shell dazwischen. `cd`, `export`,
`source` etc. sind Bash-Builtins und keine Binaries auf `$PATH`,
also schlagen sie fehl mit `executable file not found`:

```sh
$ monoceros run sandbox -- cd projects && claude
OCI runtime exec failed: exec: "cd": executable file not found
```

Wenn du Shell-Builtins brauchst, ruf explizit eine Shell auf:

```sh
$ monoceros run sandbox -- bash -lc 'cd projects && claude'
```

Die Single-Quotes sind wichtig, sonst zerlegt deine Host-Shell die
`&&`-Pipeline und das `claude` würde host-seitig laufen.

## Verwandte Befehle

- [`monoceros shell <name>`](./shell.md) — interaktive Bash-Sitzung
- [`monoceros apply <name>`](./apply.md) — Container bauen + hochfahren

## Fail-Modi

- **`No command provided`** — kein `--` gefolgt von einem Befehl
  übergeben.
- **`No .devcontainer/ at <path>`** — Container nie materialisiert.
- **`OCI runtime exec failed`** — der innere Befehl existiert nicht
  im Container. Häufig bei Shell-Builtins (siehe oben) oder bei
  einem Tool, das nicht durch ein Feature installiert wurde.
