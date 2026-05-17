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
  - ref: ghcr.io/monoceros/features/claude-code:1
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
  --namespace monoceros/features \
  ./images/features/claude-code
```

Der finale GitHub-Org-Name wird in M4 entschieden; im Code ist heute
`monoceros` als Platzhalter verdrahtet. Sollte die Org beim Publish
anders heißen, ist's ein globales sed über das Repo.

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

| Ordner        | Tool                      | Status |
| ------------- | ------------------------- | ------ |
| `claude-code` | Anthropic Claude Code CLI | live   |
