# Template-Katalog

Mitgelieferte Solution-Config-Vorlagen für `monoceros init`. Jede `*.yml`
hier ist eine **read-only** Startvorlage. Beim Aufruf von

```sh
monoceros init <template> <name>
```

wird die Datei nach `.local/container-configs/<name>.yml` kopiert und der
`name`-Eintrag durch `<name>` ersetzt. Die Kopie ist ab dem Punkt die
Wahrheit — alle `monoceros add-*` / `monoceros remove-*`-Befehle editieren
sie, nicht das Template hier.

## Verfügbare Templates

| Template        | Stack                                       | Wofür                                                               |
| --------------- | ------------------------------------------- | ------------------------------------------------------------------- |
| `bare`          | Node (Base-Image), sonst nichts             | Minimaler Startpunkt; alles Weitere via `add-*` dazu                |
| `nodejs-github` | Node (Base) + GitHub CLI (`gh`)             | TypeScript-/Node-Solution mit GitHub-Repos (HTTPS-Auth automatisch) |
| `python`        | Python (Feature) + lokaler Postgres-Service | Python-App mit lokaler DB; intern erreichbar als Host `postgres`    |
| `reference`     | Alles auskommentiert, jedes Feld erklärt    | Nachschlagewerk — zeigt jede yml-Option auf einen Blick             |

## Eine eigene Vorlage hinzufügen

1. Datei `templates/yml/<name>.yml` mit gültigem Schema (`schemaVersion: 1`)
   anlegen. Beispiel-Templates oben zeigen die Konventionen.
2. Kommentare großzügig — Builder lesen die yml als Inline-Doku, und der
   Reader/Writer in `packages/cli/src/config/io.ts` preserved sie auch
   nach `add-*`/`remove-*`-Mutations.
3. `name` als Platzhalter — kann auf den Template-Namen gesetzt werden;
   `monoceros init` schreibt ihn beim Kopieren um.
4. Eintrag in der Tabelle hier ergänzen.
