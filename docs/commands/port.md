# `monoceros port`

Listet die Traefik-URLs eines Containers — Default-Hostname plus
expliziter Port-Hostname pro `routing.ports`-Eintrag.

```sh
monoceros port <name>
```

## Zweck

`monoceros add-port` schreibt die Ports in die yml und legt die
Traefik-Dynamic-Config ab — wer dann wissen will, **unter welchen
URLs der Container erreichbar ist**, ruft `port` auf. Spart das
Subdomain-Pattern aus dem Kopf zu konstruieren und reflektiert
korrekt einen vom Default abweichenden Host-Port aus
`monoceros-config.yml`.

## Mechanik

1. Liest `routing.ports` aus `$MONOCEROS_HOME/container-configs/<name>.yml`.
2. Liest `routing.hostPort` aus `monoceros-config.yml` (Default 80).
3. Berechnet das URL-Set:
   - `http://<name>.localhost[:<hostPort>]` → erster Port (default)
   - `http://<name>-<port>.localhost[:<hostPort>]` → jeder Port einzeln
4. Druckt in TTY-Mode als ausgerichtete Tabelle, beim Pipen als
   tab-separierte Zeilen (`port<TAB>url<TAB>tag`, Tag entweder
   `default` für die Default-Zeile oder leer).

## Argumente

| Argument | Bedeutung                                                     |
| -------- | ------------------------------------------------------------- |
| `<name>` | Container-Name (yml in `$MONOCEROS_HOME/container-configs/`). |

## Beispiele

### Container mit drei Ports, Default-Host-Port 80

```sh
$ monoceros port sandbox
  3000  →  http://sandbox.localhost       (default)
  3000  →  http://sandbox-3000.localhost
  5173  →  http://sandbox-5173.localhost
  6006  →  http://sandbox-6006.localhost
```

### Mit `routing.hostPort: 8080` in `monoceros-config.yml`

```sh
$ monoceros port sandbox
  3000  →  http://sandbox.localhost:8080       (default)
  3000  →  http://sandbox-3000.localhost:8080
  5173  →  http://sandbox-5173.localhost:8080
  6006  →  http://sandbox-6006.localhost:8080
```

### Container ohne Ports

```sh
$ monoceros port sandbox
ℹ No ports declared in sandbox.yml. Run `monoceros add-port sandbox -- <port>` to expose one.
```

### Maschinenlesbar (gepiped)

```sh
$ monoceros port sandbox | head -2
3000	http://sandbox.localhost	default
3000	http://sandbox-3000.localhost
```

Für `awk`/`grep`-Pipelines:

```sh
# Nur die URL, kein "Default"-Duplikat
monoceros port sandbox | awk -F'\t' '$3 == "" { print $2 }'
```

## Verwandte Befehle

- [`add-port`](./add-port.md) — Port zur yml + Dynamic-Config hinzufügen
- [`remove-port`](./remove-port.md) — Port wieder entfernen
- [`monoceros apply <name>`](./apply.md) — Container mit dem
  aktuellen Port-Stand materialisieren

## Fail-Modi

- **`No such config`** — Container-yml existiert nicht.
  `monoceros init <name>` vorher.
- **`Invalid solution config`** — `routing.ports` enthält einen
  Eintrag, der das Schema verletzt. Die Fehlermeldung zeigt die
  Stelle (Punkt-Pfad) und was erwartet wurde.
