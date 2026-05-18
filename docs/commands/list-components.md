# `monoceros list-components`

Gibt den Komponenten-Katalog aus, den
[`monoceros init`](./init.md) für sein `--with=…`-Flag versteht.

```sh
monoceros list-components
```

## Zweck

Wenn der Builder nicht mehr weiß, **welche Bausteine** es gibt,
ist `list-components` der schnellste Weg zur Antwort —
schneller als `init` ohne `--with` (dokumentierte Vorlage lesen)
und schneller als die Quellen unter
[`templates/components/`](../../templates/components/) selbst zu
öffnen.

Der Output ist explizit Tab-getrennt, damit sich die Liste
problemlos in andere Tools pipen lässt:

```
# language
node       Node 22 + pnpm
python     Python 3.x via devcontainers/features/python

# service
mysql      MySQL 8 compose service
postgres   PostgreSQL 16 compose service
redis      Redis 7 compose service

# feature
atlassian          Atlassian CLIs (Rovo Dev + Teamwork Graph), both on
atlassian/rovodev  Atlassian Rovo Dev only (via acli rovodev)
atlassian/twg      Atlassian Teamwork Graph CLI only (twg)
claude             Anthropic Claude Code CLI
github             GitHub CLI (gh)
```

Die linke Spalte ist genau der Name, den `monoceros init --with=…`
erwartet. Komma-getrennt mehrere Komponenten kombinierbar:

```sh
monoceros init sandbox --with=node,postgres,github,claude
```

## Argumente

Keine — der Befehl liest immer den vollen Katalog der laufenden
Workbench.

## Verwandte Befehle

- [`monoceros init`](./init.md) — Komponenten in eine fertige
  yml komponieren oder eine dokumentierte Vorlage erzeugen
