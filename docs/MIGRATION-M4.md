# Migration auf M4 — Namespace-Cut

Stand: **2026-05-19**.

Mit M4 zieht Monoceros auf seine eigene GitHub-Org und seinen
eigenen npm-Scope um. Bestehende Container-yml's und persönliche
`monoceros-config.yml`-Dateien tragen noch die alten Namen und
müssen einmal manuell angefasst werden.

## Was sich ändert

| Was           | Vorher                              | Jetzt                                          |
| ------------- | ----------------------------------- | ---------------------------------------------- |
| GitHub-Org    | `conciso`                           | `getmonoceros`                                 |
| Repo-Name     | `monoceros-workbench`               | `workbench`                                    |
| npm-Paket     | `@monoceros/cli` (unveröffentlicht) | `@getmonoceros/workbench`                      |
| GHCR-Features | `ghcr.io/monoceros/features/<x>`    | `ghcr.io/getmonoceros/monoceros-features/<x>`  |
| GHCR Runtime  | (lokal `monoceros-runtime:dev`)     | `ghcr.io/getmonoceros/monoceros-runtime:<tag>` |

Der lokale Binary-Name (`monoceros`) bleibt gleich, ebenso die
yml-Struktur, das Layout unter `$MONOCEROS_HOME` und alle Befehle.

## Was du tun musst

### 1. Container-yml's anpassen

In allen `*.yml`-Dateien unter
`$MONOCEROS_HOME/container-configs/` (dev:
`<workbench>/.local/container-configs/`, prod:
`~/.monoceros/container-configs/`) müssen Feature-Refs umgeschrieben
werden:

```sh
# Dev-Modus (im Workbench-Checkout):
sed -i '' 's|ghcr\.io/monoceros/features/|ghcr.io/getmonoceros/monoceros-features/|g' \
  .local/container-configs/*.yml

# Prod-Modus (npm-Install):
sed -i '' 's|ghcr\.io/monoceros/features/|ghcr.io/getmonoceros/monoceros-features/|g' \
  ~/.monoceros/container-configs/*.yml
```

(Linux: `sed -i` ohne das leere `''`-Argument.)

### 2. `monoceros-config.yml` anpassen

Wenn du Default-Optionen pro Feature unter
`defaults.features.<ref>` gepflegt hast, sind die Keys ebenfalls
betroffen:

```sh
sed -i '' 's|ghcr\.io/monoceros/features/|ghcr.io/getmonoceros/monoceros-features/|g' \
  ~/.monoceros/monoceros-config.yml   # bzw. .local/monoceros-config.yml
```

### 3. Apply neu fahren

Pro betroffenem Container:

```sh
monoceros apply <name>
```

## Was passiert, wenn du nichts tust

`monoceros apply` erkennt den alten Ref-Stil und gibt eine Warnung
aus:

```
⚠ Deprecated feature ref in container yml:
  'ghcr.io/monoceros/features/claude-code:1'. Replace with
  'ghcr.io/getmonoceros/monoceros-features/claude-code:1' — the
  old namespace is no longer published. See docs/MIGRATION-M4.md
  for a sed snippet.
```

Apply läuft danach trotzdem weiter, devcontainer-cli versucht den
alten Pfad gegen GHCR aufzulösen und schlägt fehl, weil unter der
alten Org nichts (mehr) liegt. Die Warnung sagt dir, wie du's fixt.

## Lokale Remote-URL umstellen (Workbench-Contributors)

Wenn du das Workbench-Repo selbst geklont hast, zeigt `origin`
heute noch auf `conciso/monoceros-workbench`. GitHub redirected,
aber sauber ist sauber:

```sh
git remote set-url origin https://github.com/getmonoceros/workbench.git
git fetch origin
```

## Warum der Cut

`monoceros` war als GitHub-Org und npm-Scope nicht verfügbar.
`getmonoceros` ist beides — Org auf GitHub, Org auf npm, GHCR-
Namespace — und gehört uns. Siehe
[`docs/m4-brief.md`](m4-brief.md) für den ganzen Hintergrund und
die Namens-Verfügbarkeitsprüfung am 2026-05-19.
