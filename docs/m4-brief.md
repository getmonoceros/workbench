# M4-Brief — Distribution / Go-Live (historisch)

> **Status: superseded am 2026-05-19** durch
> [ADR 0004 — Release-Modell: N unabhängige Deployments,
> Version-getriggert](./adr/0004-release-modell-m4.md).
>
> Dieser Brief beschreibt den Stand am Morgen des 2026-05-19 vor
> der Architekturdiskussion. Er nahm implizit zwei Deployments an
> (CLI + Feature-Library) und setzte auf `npm install -g
@getmonoceros/workbench` als Distributionspfad. Beide Annahmen
> sind verworfen: heute sind es fünf Deployments und wachsend,
> Distribution läuft über GitHub-Releases mit plattformspezifischen
> Tarballs plus Install-Skripten (`install.sh` / `install.ps1`).
> Windows ist explizit als Zielplattform mit drin.
>
> Inhaltlich gültig im Brief ist alles bis Task 1 (Code & Docs auf
> `getmonoceros`) — das ist umgesetzt und Teil von M4-Task 1 im
> Backlog. Die Pre-Flight-Schritte (Org, npm-Org, Repo-Transfer,
> GHCR-PAT) sind ebenfalls durch. Alles ab Task 2 im Brief ist
> durch ADR 0004 ersetzt. Operative Wahrheit für M4 ist die ADR
> plus die nummerierten Tasks in [`backlog.md`](./backlog.md).
>
> Wir lassen den Brief stehen statt zu löschen, weil er den
> Diskussionsverlauf zwischen Pivot und ADR dokumentiert.

Stand des ursprünglichen Hand-Overs: **2026-05-19**. Geschrieben
als Hand-Over für eine frische Session, die M4 anfasst.

## Was M4 erreichen muss

> Ein Builder, der das `monoceros-workbench`-Repo **nie geklont
> hat**, kann mit `npm install -g @getmonoceros/workbench` plus
> `monoceros init hello --with=claude && monoceros apply hello`
> einen Container hochfahren — Runtime-Image und Features
> werden aus GHCR gezogen, keine lokalen Files nötig.

## Entscheidungen (fix, nicht mehr diskutieren)

Diese Namen wurden geprüft (Availability auf GitHub + npm
verifiziert am 2026-05-19) und sind die Wahrheit für M4:

| Was                      | Name                                                      |
| ------------------------ | --------------------------------------------------------- |
| GitHub-Org               | `getmonoceros`                                            |
| GitHub-Repo (nach Umzug) | `github.com/getmonoceros/workbench`                       |
| npm-Scope                | `@getmonoceros`                                           |
| npm-Paket (CLI)          | `@getmonoceros/workbench`                                 |
| CLI-Binary-Name (`bin`)  | `monoceros`                                               |
| GHCR Runtime-Image       | `ghcr.io/getmonoceros/monoceros-runtime:<tag>`            |
| GHCR Features            | `ghcr.io/getmonoceros/monoceros-features/<feature>:<tag>` |
| CI                       | GitHub Actions                                            |

Versions-Strategie: SemVer für `@getmonoceros/workbench`.
Runtime-Image und Features bekommen zwei Tags pro Release:

- `<version>` (z.B. `1.0.0`) — pinned
- `1` (Major-Tag) — mitwachsend, für `ref: …:1` in yml

## Pre-Flight (manuell, vor dem ersten M4-Commit)

Diese Schritte sind nicht-coding-able. Bitte einmal durch:

1. **GitHub-Org `getmonoceros` anlegen** — siehe
   https://github.com/account/organizations/new. Free plan reicht;
   keine kostenpflichtigen Features in M4 nötig.

2. **Repo übertragen**: `conciso/monoceros-workbench` → `getmonoceros/workbench`.
   Settings → General → Transfer ownership. GitHub schreibt
   `conciso/monoceros-workbench` automatisch als Redirect auf
   `getmonoceros/workbench`, also brechen pinning-clones nicht.

3. **npm-Account vorbereiten** — wer publisht? Persönlicher
   Account mit npm-Org `getmonoceros` (kostenlos für public
   packages, dann gehört der Scope automatisch der Org) ist die
   beste Variante:
   - `npm org create getmonoceros` (wenn nicht schon angelegt)
   - 2FA aktivieren (npm verlangt das bei publish heute)
   - npm-Token mit `publish`-Scope erzeugen, für CI im Org-
     Secret-Store ablegen.

4. **GHCR-Auth-Konzept** entscheiden: für M4 reicht ein
   **classic PAT mit `write:packages`-Scope** vom Org-Admin,
   abgelegt als `secrets.GHCR_TOKEN` in `getmonoceros/workbench`
   Settings. Später kann das auf eine GitHub-App umsteigen.

## Tasks (in dieser Reihenfolge)

### Task 1 — Code & Docs auf `getmonoceros` umstellen

Ein Find-Replace-Sweep durchs Repo. Heute steht die alte Org
`monoceros` (ohne `get`) in vielen Tests, Sample-Configs und
Doc-Beispielen. Das muss alles auf `getmonoceros` umziehen —
inklusive einem neuen Pfad-Segment (`monoceros-features` statt
nur `features`, weil GHCR's Repo-Name die volle Library-
Bezeichnung trägt).

**Code (semantisch wichtig)**:

- `packages/cli/src/create/scaffold.ts` →
  `MONOCEROS_FEATURE_RE`. Heute:
  `/^ghcr\.io\/monoceros\/features\/([a-z0-9._-]+):[a-z0-9._-]+$/`.
  Neu: `/^ghcr\.io\/getmonoceros\/monoceros-features\/([a-z0-9._-]+):[a-z0-9._-]+$/`.
  Plus den localSourceDir-Bau anpassen.
- `packages/cli/src/init/manifest.ts` →
  `MONOCEROS_FEATURE_RE` (dieselbe Logik dupliziert; sollte bei
  der Gelegenheit nach `create/catalog.ts` oder ein neues
  `util/ref.ts` extrahiert werden).

**Package-Namen**:

- `packages/cli/package.json`: `name: @monoceros/cli` →
  `@getmonoceros/workbench`. Plus `bin: { monoceros: "..." }`
  prüfen (existiert heute, korrekter Pfad nach Build).
- Root-`package.json`: `"cli": "pnpm --filter @monoceros/cli start"` →
  `"cli": "pnpm --filter @getmonoceros/workbench start"`.

**Tests** (Find-Replace, viele Stellen):

```
packages/cli/test/init.test.ts
packages/cli/test/global-config.test.ts
packages/cli/test/components.test.ts
packages/cli/test/apply-yml.test.ts
```

Sed-Vorschlag:

```sh
fd '\.(ts|md|yml|json)$' . \
  -E node_modules -E .git -E images/features \
  -X sed -i '' 's|ghcr\.io/monoceros/features/|ghcr.io/getmonoceros/monoceros-features/|g'
```

Vorsicht: `images/features/<name>/devcontainer-feature.json` der
Feature-Manifeste sollte das NICHT in der `id`-Property ändern —
nur in Doc-Strings/Verweisen.

**Docs**:

```
docs/konzept.md            (mehrfach <org> + Code-Beispiele)
docs/backlog.md            (Statt-<org>-Placeholders)
docs/ai-tools.md           (1 Vorkommen im foo-Beispiel)
docs/commands/init.md      (Doku der Ausgabe-Beispiele)
images/features/README.md  (1 Vorkommen)
.local/monoceros-config.sample.yml
.local/README.md
```

Die `<org>`-Placeholder werden komplett durch `getmonoceros`
ersetzt. Das ist eine Find-Replace-Übung.

**Sandbox.yml & andere live-yml-Konfigs unter `.local/container-configs/`**:
Der User hat Live-Container am Laufen mit `ref: ghcr.io/monoceros/features/...`.
Wenn die Refs nach dem Code-Cut nicht mehr matchen, breakt die
Local-Source-Resolution. Zwei Varianten:

- **a)** Den User bitten, seine yml's mit `sed` zu fixen +
  `monoceros apply` neu zu fahren.
- **b)** Code-seitig ein Migration-Hint: wenn der alte Ref-Stil
  beim Apply erkannt wird, eine warnende Logger-Meldung
  ausgeben mit dem korrigierten Ref. Nur Warn, nicht Fail —
  Builder kann von Hand fixen.

Empfehlung: **b**, plus DEPRECATED-Hinweis in einer
`MIGRATION-M4.md` für ähnliche Fälle.

**Tests grün halten**: nach dem Find-Replace `pnpm --filter @getmonoceros/workbench test` —
muss 170/170 grün bleiben.

### Task 2 — Feature-Library nach GHCR publishen

Vorbedingung: Org `getmonoceros` existiert, GHCR-PAT bereit.

Tooling: `@devcontainers/cli features publish`. Ein Manifest pro
Feature, Authorization gegen GHCR mit `docker login ghcr.io`.

Schritte pro Feature (manuell für den ersten Publish):

```sh
cd images/features/claude-code
echo "$GHCR_TOKEN" | docker login ghcr.io -u <username> --password-stdin
npx -y @devcontainers/cli features publish \
  --namespace getmonoceros/monoceros-features \
  .
```

Output: das Feature liegt unter
`ghcr.io/getmonoceros/monoceros-features/claude-code:1.0.0`

- Tag `1` (automatisch nach SemVer-Major).

Wiederholen für `atlassian`, `github-cli`.

**Anschließend**: das in der yml referenzieren und apply testen
ohne lokales `images/features/` (umbenennen lokal, prüfen dass
es immer noch funktioniert weil GHCR jetzt antwortet).

Die Local-Source-Auflösung im Scaffold bleibt drin als Fallback
für Contributors. Default-Path: GHCR. Override-Path: lokal,
wenn `images/features/<name>/` existiert (im Workbench-Checkout
also weiterhin auto-detect).

### Task 3 — Runtime-Image nach GHCR pushen

Multi-Arch via Docker Buildx:

```sh
docker buildx create --use --name monoceros-builder
cd images/runtime
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t ghcr.io/getmonoceros/monoceros-runtime:0.1.0 \
  -t ghcr.io/getmonoceros/monoceros-runtime:0 \
  --push \
  .
```

Anschließend `BASE_IMAGE` in `packages/cli/src/create/catalog.ts`
von `monoceros-runtime:dev` auf
`ghcr.io/getmonoceros/monoceros-runtime:0` umstellen.

Dev-Mode-Fallback überlegen: für Contributors die am Runtime-
Image arbeiten und einen lokalen Build testen wollen.

- Vorschlag: Env-Variable `MONOCEROS_BASE_IMAGE_OVERRIDE` (oder
  ähnlich), die `BASE_IMAGE` während des Scaffold-Generierens
  überschreibt. Default = GHCR-Tag, override = lokales
  `monoceros-runtime:dev`.

### Task 4 — `@getmonoceros/workbench` als npm-Paket publishen

Schritte:

1. `packages/cli/package.json` aufräumen: `name`, `version`,
   `description`, `bin`, `keywords`, `repository`, `homepage`,
   `license`, `files` (nur dist + package.json + README). Heute
   ist `package.json` minimal — alles Publish-Ready machen.
2. `prepublishOnly` Skript hinzufügen, das `pnpm typecheck` +
   `pnpm test` ausführt.
3. Build-Schritt klären: heute laufen Tests direkt gegen `src/`
   per `tsx`. Für den npm-Publish brauchen wir ein
   `dist/`-Verzeichnis mit CJS- oder ESM-Output. Tools-Wahl:
   `tsup` oder `tsc --build` mit eigenem Output-Layout. tsup ist
   simpler.
4. `npm publish --dry-run` lokal, prüfen was im Tarball landet.
5. Echter Publish: `npm publish --access public`. Erster
   Publish reserviert den `@getmonoceros`-Scope und legt den
   `monoceros`-Binary-Eintrag fest.

### Task 5 — `pnpm cli`-Workaround degradieren

Heute: Root `package.json` hat ein `cli`-Script das per
`pnpm --filter` die `src/bin.ts` startet. Nach Publish gibt's
das Binary global; das Root-Script wird Dev-Convenience für
Contributors.

Konkret: kein Code-Change nötig. Eine README-Notiz reicht:
"Wenn du am Workbench arbeitest, ist `pnpm cli` der schnellste
Weg zum lokalen Stand. End-User installieren stattdessen
`@getmonoceros/workbench` global."

### Task 6 — Install-Doku im Workbench-Root

Eine neue `README.md` (oder die existierende ergänzen) mit
**drei expliziten Zielgruppen-Pfaden**:

1. **„Ich will Monoceros nur nutzen"**:

   ```sh
   npm install -g @getmonoceros/workbench
   monoceros init hello --with=claude,github
   # Tokens in ~/.monoceros/monoceros-config.yml eintragen
   monoceros apply hello
   ```

2. **„Ich entwickle am Workbench"**:

   ```sh
   git clone https://github.com/getmonoceros/workbench
   cd workbench
   pnpm install
   pnpm cli init …
   ```

3. **„Ich nutze eine bestehende Solution"**: kurzer
   Verweis auf `docs/commands/README.md` plus die wichtigsten
   yml-Felder.

### Task 7 — CI-Skeleton (GitHub Actions)

Eine Datei: `.github/workflows/ci.yml`. Drei Jobs:

- **lint-test**: läuft bei jedem PR + push auf main.
  `pnpm install --frozen-lockfile && pnpm typecheck && pnpm test`.
- **publish-feature** (manual + on tag): publisht alle Features
  in `images/features/*/` nach GHCR per
  `@devcontainers/cli features publish`. Verwendet
  `secrets.GHCR_TOKEN`.
- **publish-runtime + npm** (on tag): baut + pusht Runtime-Image
  multi-arch + npm publish. Trigger: Git-Tag `v*` an einem
  Release-Branch.

Stolperstein: GitHub Actions hat keinen direkten Postgres-
Service auf dem Runner für unsere Unit-Tests (brauchen wir
auch nicht — wir mocken Docker). Lokal-Test reicht.

### Task 8 — `MONOCEROS_HOME`-Default schärfen

Heute: `monocerosHome()` macht eine Dev-Detection durch das
Aufwärts-Walken bis `<dir>/.local/monoceros-config.sample.yml`
gefunden wird. Für einen npm-installierten Builder gibt's
diesen Marker nicht — der Fallback ist `~/.monoceros/`. Das
funktioniert schon heute, muss nur explizit getestet werden:

- Smoke: `cd /tmp && monoceros init hello --with=claude` →
  legt yml unter `~/.monoceros/container-configs/hello.yml` an.
- Smoke: `monoceros apply hello` → materialisiert nach
  `~/.monoceros/container/hello/`.

Falls da was hakt: `monoceros-config.yml` muss u.U. beim ersten
Aufruf auto-angelegt werden (mindestens eine leere mit
`schemaVersion: 1`).

### Task 9 — End-to-End-Walkthrough von außen

Auf einem zweiten Rechner (oder einer frischen VM):

- npm install -g @getmonoceros/workbench
- monoceros init hello --with=node,postgres,claude
- monoceros-config.yml mit Claude-API-Key füllen
- monoceros apply hello
- monoceros shell hello, claude `Hallo!` tippen

Wenn das ohne Workbench-Checkout durchläuft → M4 = ✅.

## Stolpersteine die ich vor-flagge

1. **Backward-Compat der Feature-Refs in existierenden yml-
   Dateien**. Du (Thorsten) hast Live-Container, deren yml
   `ghcr.io/monoceros/features/...` referenziert. Nach Task 1
   matched die Local-Source-Resolution nicht mehr. Konsequenz:
   apply schlägt die Local-Auflösung aus, geht zu GHCR mit der
   alten Org → 404 oder altes Paket. Migration-Hint im Apply
   bauen, plus manuelles `sed` auf den eigenen yml's.

2. **GitHub-Repo-Umzug bricht Commit-Hashes nicht** aber
   **bricht möglicherweise lokale Remote-URLs**. Nach Transfer
   `git remote set-url origin git@github.com:getmonoceros/workbench.git`
   auf jeder Entwickler-Maschine. GitHub legt zwar Redirects an,
   aber sauberer URL-Update ist nicht falsch.

3. **npm-Scope: erster Publish ist privileged**. Wer das
   erste Mal `@getmonoceros/workbench` publisht, "claimt" damit
   den Scope. Wenn das nicht über die `getmonoceros`-Org passiert,
   gehört der Scope der Person — die kann später schwer den
   Scope an die Org übertragen. Erst Org auf npm anlegen, dann
   `npm publish --access public` als Org-Member.

4. **GHCR-Visibility nach Publish**: GHCR-Packages sind per
   Default `private`. Manuell auf `public` switchen in den
   Package-Settings — sonst kann der externe Builder die
   Features nicht ziehen.

5. **Versions-Drift zwischen CLI und Features**. Wenn das CLI
   v1.2.3 published wird und die Features bei v0.x sind: kein
   Problem, weil refs in yml die Feature-Version pinnen.
   Trotzdem im Hinterkopf behalten — irgendwann Cooler-Job zum
   Synchronisieren.

6. **Egress-Allowlist (ADR 0002)** lebt noch in
   `images/runtime/`. Wenn das Runtime-Image nach GHCR
   gepusht wird, fährt die Mechanik mit raus. Default ist
   `off`, also nicht aktiv für Builder. Aber: einmal kurz
   ehrlich prüfen ob die Mechanik raus soll bevor wir sie
   versehentlich verewigen (siehe M5 Task 5).

## Definition of Done

Aus dem Backlog (kopiert weil verbindlich):

- ✅ Ein Builder ohne Workbench-Checkout kann via
  `npm install -g @getmonoceros/workbench` und
  `monoceros init hello --with=claude && monoceros apply hello`
  einen Container hochfahren — Runtime-Image **und** Features
  werden aus GHCR gezogen, keine lokalen `images/...`-Files
  nötig.
- ✅ `ghcr.io/getmonoceros/monoceros-features/{claude-code,atlassian,github-cli}`
  via `docker pull` / `devcontainer features info` von außen
  erreichbar.
- ✅ Stage E-Walkthrough von außen (Test-Plan) durchgespielt.
- ✅ README erklärt, was Monoceros ist und wie man's installiert.

## Was M4 NICHT macht

- Keine Web-UI, kein Hub, keine Cloud-Variante. Bleibt
  Local-Tool.
- Keine Versionierung der yml selbst (schemaVersion bleibt
  bei 1; bei Breaking Changes irgendwann v2 mit Migration-
  Helper, aber das ist eigene Etappe).
- Kein automatischer Update-Check (`npm update -g …` reicht).
