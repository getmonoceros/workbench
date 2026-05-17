# Monoceros Devcontainer Features

In diesem Ordner liegen die von Monoceros gepflegten Devcontainer-
Features. Jedes Feature ist ein Unterordner mit zwei Dateien:

- `devcontainer-feature.json` — Metadaten + Options-Schema + ggf.
  `mounts` / `containerEnv` / etc.
- `install.sh` — wird beim Container-Build als root ausgeführt

## Referenzierung in einer Container-yml

Lokale Referenz während der Entwicklung (relativ zum
Workbench-Checkout):

```yaml
features:
  - ref: ./features/claude-code
```

Der Scaffold löst `./features/<name>` zum absoluten Pfad
`<workbench>/images/features/<name>` auf, bevor er das in die
generierte `devcontainer.json` schreibt. devcontainer-cli akzeptiert
absolute Filesystem-Pfade als Feature-Refs.

Sobald die Features publiziert sind (M4 — Distribution), wechseln
Templates auf den vollen OCI-Ref:

```yaml
features:
  - ref: ghcr.io/<org>/monoceros-features/claude-code:1
```

## Publishen (manuell, später per CI)

Mit `@devcontainers/cli`:

```sh
npx -y @devcontainers/cli features publish \
  --namespace <org>/monoceros-features \
  ./images/features/claude-code
```

Der Namespace ist in M4 noch nicht final entschieden (siehe Backlog).

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
