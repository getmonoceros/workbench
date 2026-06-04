# Monoceros Devcontainer Features

In diesem Ordner liegen die von Monoceros gepflegten Devcontainer-
Features. Jedes Feature ist ein Unterordner mit zwei Dateien:

- `devcontainer-feature.json` — Metadaten + Options-Schema + ggf.
  `mounts` / `containerEnv` / etc.
- `install.sh` — wird beim Container-Build als root ausgeführt

## Referenzierung in einer Container-yml

Templates und Builder-yml-Dateien nutzen **immer** den vollen OCI-Ref:

```yaml
features:
  - ref: ghcr.io/getmonoceros/monoceros-features/claude-code:1
```

Derselbe Ref funktioniert in dev und in prod. Während der Entwicklung
am Workbench-Repo prüft der Scaffold, ob `images/features/<name>/`
lokal existiert; wenn ja, wird der Build-Pfad transparent auf die
lokale Kopie umgebogen, sodass Änderungen am Feature ohne GHCR-Push
testbar sind. In einer Installation ohne Workbench-Checkout läuft die
Auflösung über den echten GHCR-Pull.

## Publishen (manuell, später per CI)

Mit `@devcontainers/cli`:

```sh
npx -y @devcontainers/cli features publish \
  --namespace getmonoceros/monoceros-features \
  ./images/features/claude-code
```

Org-Name (`getmonoceros`) und GHCR-Namespace (`monoceros-features`)
sind seit M4 fix; siehe
[ADR 0004](../../docs/adr/0004-release-modell-m4.md) für die
Hintergründe.

## Ein neues Feature dazulegen

1. Unterordner `images/features/<name>/` anlegen
2. `devcontainer-feature.json` schreiben — Pflichtfelder: `id`,
   `name`, `version`. Optional `options`, `mounts`, `containerEnv`,
   `entrypoint`, `installsAfter`, `dependsOn`.
3. `install.sh` schreiben — läuft als root, mit den Options als
   Environment-Variablen (lowercased → uppercased mit `$` prefix).
4. Template-Variante anlegen falls sinnvoll
   (`templates/yml/<name>.yml` oder Eintrag in bestehende Templates)
5. Hier in der README einen kurzen Hinweis ergänzen

## Aktuelle Features

| Ordner        | Tool                                          | Status |
| ------------- | --------------------------------------------- | ------ |
| `claude-code` | Anthropic Claude Code CLI                     | live   |
| `atlassian`   | Atlassian CLIs (Rovo Dev über `acli` + `twg`) | live   |
| `github-cli`  | GitHub CLI (`gh`)                             | live   |

## Monoceros-Konventionen oberhalb des Devcontainer-Feature-Specs

Zusätzlich zu den Standardfeldern werten die Monoceros-Scaffolder
ein Extension-Feld `x-monoceros` in der `devcontainer-feature.json`
aus:

```jsonc
{
  "id": "claude-code",
  ...
  "x-monoceros": {
    "persistentHomePaths": [".claude"]
  }
}
```

- **`persistentHomePaths`** — Liste von Subpfaden unterhalb von
  `/home/node/`, die der Container persistent halten soll. Beim
  `monoceros apply` wird unter `<container-dir>/home/<path>` ein
  Hostverzeichnis angelegt und in die `devcontainer.json` als
  Bind-Mount eingetragen. Damit überlebt Login + Tool-State jeden
  Apply-Rebuild und bleibt pro Container isoliert. Details:
  [`docs/adr/0003-container-state-model.md`](../../docs/adr/0003-container-state-model.md).

### Post-Create-Hooks

`install.sh` läuft beim Image-Build und sieht die Bind-Mounts noch
nicht — d.h. ein Auth-Login der in `/home/node/.config/...`
schreiben soll, gehört nicht ins `install.sh`. Stattdessen darf
`install.sh` ein Skript unter
`/usr/local/share/monoceros/post-create.d/<feature>.sh` ablegen;
das vom Scaffold generierte `post-create.sh` ruft alle Skripte dort
beim Container-Start auf. Konvention für solche Hooks: idempotent
(skip wenn schon eingeloggt), klare Logzeilen, exit 0 wenn nichts
zu tun.
