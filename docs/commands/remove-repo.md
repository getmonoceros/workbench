# `monoceros remove-repo`

Inverse zu [`add-repo`](./add-repo.md). Entfernt einen Repo-Eintrag
aus der Konfig.

## Synopsis

```sh
monoceros remove-repo <url-or-name> [--yes] [--project=<path>]
```

Das Argument matched sowohl:

- die volle URL des Eintrags (`git@github.com:foo/bar.git`,
  `https://github.com/foo/bar.git`) als auch
- den effektiven Folder-Namen unter `projects/` (`bar`, oder den
  expliziten `name:` aus der yml).

## Mechanik

- Bei Phase-3: Der entsprechende Array-Eintrag in `repos:` wird aus
  der yml entfernt.
- Bei Legacy: `stack.json.repos` wird gefiltert; im nächsten `apply`
  fällt der Clone-Block aus `post-create.sh` raus.
- Wenn nach dem Entfernen keine Repos mehr da sind, werden die
  Git-Auth-Mounts (SSH-Agent-Forwarding,
  HTTPS-Credentials-Fetch) aus dem Devcontainer entfernt.

**Wichtig — der bestehende `projects/<name>/`-Folder wird NICHT
gelöscht.** Lokale Edits des Builders sollen nicht durch ein
`remove-repo` verloren gehen. Aufräumen ist manuell:

```sh
monoceros remove-repo bar --yes
monoceros apply
rm -rf projects/bar   # manuell, wenn du die lokale Kopie nicht mehr brauchst
```

## Idempotenz

URL/Name nicht in der Liste → no-change.

## Verwandte Befehle

- `monoceros add-repo` — Inverse
- `monoceros apply` — Materialisierung
