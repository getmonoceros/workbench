# `monoceros add-from-url`

Fügt eine HTTPS-Install-Script-URL hinzu, die bei jedem Container-
Rebuild via `bash <(curl -fsSL <url>)` ausgeführt wird.

## Zweck

Manche Tools haben weder ein Devcontainer-Feature noch ein apt-Paket,
sondern werden über eine projektspezifische Install-Skript-URL
installiert. Beispiele:

- `bash <(curl -fsSL https://teamwork-graph.atlassian.com/cli/install)` (TWG-CLI)
- `bash <(curl -fsSL https://get.acmecorp.io/install)` (interne Tools)

`add-from-url` versorgt die Solution deklarativ mit solchen Installs:
einmal hinzufügen, danach läuft das Skript automatisch bei jedem
`monoceros apply` und auf jeder anderen Maschine, die die Solution
übernimmt.

## ⚠️ Sicherheitsdimension

Das ist **per Design Remote-Code-Execution auf jeder
Container-Erstellung.** Der Wartende der URL kann morgen das Skript
ändern und dein Container führt den neuen Payload aus, ohne dass du
den Diff siehst. Das ist im Solution-Builder-Kontext oft vertretbar
(Tool-Maintainer ist vertrauenswürdig, URL ist Teil eines etablierten
Workflows), aber kein automatischer Default.

Der Befehl druckt deshalb **immer** eine laute Security-Warnung vor dem
Confirm. `--yes` überspringt _beide_ — Warnung und Diff — verwende es
nur in Skripten, wo die URL bereits auditiert wurde.

Reach for `add-apt-packages` oder `add-feature` zuerst, wann immer
möglich: Pakete und Devcontainer-Features kommen aus signierten,
versionierten Quellen.

## Synopsis

```sh
monoceros add-from-url <url> [--yes] [--project=<path>]
```

`<url>` ist ein positionelles Argument. Anders als `add-apt-packages` /
`add-feature` braucht `add-from-url` _kein_ `--` davor, weil URLs nicht
wie Flags aussehen.

## Optionen

| Flag               | Bedeutung                                                                      |
| ------------------ | ------------------------------------------------------------------------------ |
| `--yes` / `-y`     | Security-Warnung _und_ Diff-Confirm überspringen. Nur in auditierten Skripten. |
| `--project=<path>` | Solution-Root explizit                                                         |

## Mechanik

1. Die URL wird in `stack.json.installUrls` aufgenommen (Reihenfolge bleibt erhalten — Installs können aufeinander aufbauen).
2. `.devcontainer/post-create.sh` wird regeneriert. Ans Ende kommt:
   ```bash
   echo "→ Running N install URL(s) added via add-from-url…"
   echo "→ https://example.com/install"
   bash <(curl -fsSL "https://example.com/install")
   ```
3. Beim nächsten `monoceros apply` führt der Container das Skript aus.

`monoceros down` und neue Builds re-ausführen die Skripte erneut. Wenn
ein Skript zum zweiten Mal läuft und Tools schon installiert sind,
sollten sie das idempotent händeln — wie sich das Skript dabei verhält,
liegt am Maintainer der URL.

## Validierung

Erlaubt: `^https:\/\/[A-Za-z0-9.\-_~/:?#[\]@!&'()*+,;=%]+$`

Konkret:

- **Nur HTTPS** (kein `http://`, kein `file://`, kein `ssh://`)
- Keine Shell-Metacharacters (`$`, backtick, `;`, `|`, `&` etc.) — die URL wird per Variable-Quoting in das post-create.sh eingebettet, aber die Validierung ist Belt-and-Suspenders.

## Idempotenz

Gleiche URL ein zweites Mal hinzufügen → "No changes — solution is
already in the desired state.", Exit 0, keine Datei-Änderung.

Mehrere URLs hinzufügen → akkumuliert in der angegebenen Reihenfolge.

## Beispiele

Einzelne URL hinzufügen:

```sh
monoceros add-from-url https://teamwork-graph.atlassian.com/cli/install
# … Security-Warnung lesen … y zum Bestätigen
monoceros apply
monoceros run -- twg --version
```

Mehrere Installs, der zweite baut auf dem ersten auf:

```sh
monoceros add-from-url https://example.com/install-base
monoceros add-from-url https://example.com/install-extras   # läuft NACH install-base
monoceros apply
```

In einem Skript (URL ist auditiert):

```sh
monoceros add-from-url --yes https://my-trusted-cdn.com/install
monoceros apply
```

## Verwandte Befehle

- `monoceros add-apt-packages` — bevorzugen, wenn das Tool in den Distro-Repos liegt
- `monoceros add-feature` — bevorzugen, wenn ein Devcontainer-Feature existiert
- `monoceros apply` — Container neu bauen, damit die URL wirklich gefetched + ausgeführt wird

## Fail-Modi

- **`Invalid install URL`** — URL stimmt nicht mit dem zulässigen
  Pattern überein. Häufige Ursachen: `http://` statt `https://`,
  Leerzeichen, Sonderzeichen außerhalb URL-Safe (z. B. unencoded `<`).
- **`Missing URL`** — kein Argument übergeben.
- **Container-Build scheitert in der URL-Sektion** — das Remote-Skript
  selbst hat einen Fehler oder die URL ist nicht erreichbar. Diagnose:
  URL manuell mit `curl -fsSL <url> | less` host-seitig oder in einer
  Throwaway-Shell prüfen. Wenn die URL temporär unten ist:
  `stack.json.installUrls` händisch trimmen und apply erneut.
