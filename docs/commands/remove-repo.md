# `monoceros remove-repo`

Inverse zu [`add-repo`](./add-repo.md). Entfernt einen Repo-Eintrag aus
der Container-Konfig.

## Synopsis

```sh
monoceros remove-repo <containername> <url-or-name> [--yes]
```

Das `<url-or-name>`-Argument matched sowohl:

- die volle URL des Eintrags (`git@github.com:foo/bar.git`,
  `https://github.com/foo/bar.git`), als auch
- den effektiven Folder-Namen unter `projects/` (`bar`, oder den
  expliziten `--as=<…>` aus der yml).

## Mechanik

Der entsprechende Array-Eintrag in `repos:` wird aus der yml entfernt.
Wenn nach dem Entfernen keine Repos mehr da sind, werden beim nächsten
Apply auch die Git-Auth-Mounts (SSH-Agent-Forwarding,
HTTPS-Credentials-Fetch) aus dem Devcontainer entfernt.

**Wichtig — der bestehende `projects/<folder>/`-Ordner wird NICHT
gelöscht.** Lokale Edits sollen nicht durch ein `remove-repo` verloren
gehen. Aufräumen ist manuell:

```sh
monoceros remove-repo sandbox bar --yes
monoceros apply sandbox
rm -rf $MONOCEROS_HOME/container/sandbox/projects/bar   # manuell, wenn nicht mehr gebraucht
```

## Idempotenz

URL/Name nicht in der Liste → no-change.

## Verwandte Befehle

- `monoceros add-repo` — Inverse
- `monoceros apply <name>` — Materialisierung
