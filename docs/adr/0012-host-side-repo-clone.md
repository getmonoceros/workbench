# ADR 0012 — Repos host-seitig vor `compose up` klonen

- Status: **reverted (2026-06-03)** — siehe „Revert" am Ende
- Datum: 2026-06-02

> **Revert-Hinweis (2026-06-03):** Diese Entscheidung wurde
> zurückgenommen. Der host-seitige Clone (und der host-seitige
> `git ls-remote`-Reachability-Pre-Flight) verlagerten Netz- und
> Credential-Auflösung von der **Container**-Seite (die funktioniert)
> auf die **Host**-Seite — und produzierten dadurch plattformübergreifend
> falsche Vorab-Abbrüche: VS-Code-`GIT_ASKPASS` auf macOS, fehlende
> github.com-DNS-Auflösung des Host-git auf einer Linux-VM. Der Host hat
> nicht denselben Netz-/Auth-Kontext wie der Container. Beides ist
> entfernt; Repos werden wieder ausschließlich **in-container** geklont
> (post-create.sh) — der einzige Pfad, der auf allen Plattformen
> funktioniert. Der eigentliche Anlass dieser ADR — ein Service, der eine
> Repo-Datei bind-mountet (init.sql) und sie **vor** `compose up` braucht
> — bleibt offen und gehört **container-seitig** gelöst (z. B. ein
> Clone-Init-Schritt im Compose, von dem die Services per `depends_on`
> abhängen), nicht über den Host. Siehe backlog.md.

---

_Ursprünglicher Text (überholt):_

## Kontext

Bis hierher wurden in der Container-yml deklarierte Repos
(`repos:`) ausschließlich **in-container** geklont — die generierte
`post-create.sh` führte `git clone` aus, nachdem `devcontainer up`
den Container hochgefahren hatte. Das war konsistent (Checkout im
Ziel-Linux, Credentials über das ins Container gemountete
`.monoceros/git-credentials`) und genügte, solange Repos nur als
Workspace-Inhalt gebraucht wurden.

Mit dem generischen Service-Modell (env/volumes pro Service, siehe
backlog.md) kam ein neuer Fall dazu: ein Service kann eine **Datei aus
einem geklonten Repo** bind-mounten, z.B. Postgres'
`projects/app/init.sql` → `/docker-entrypoint-initdb.d/init.sql`.

Damit kollidiert die bisherige Reihenfolge fatal:

1. `compose up` startet Postgres und bind-mountet
   `projects/app/init.sql` — die Datei existiert noch nicht.
2. Docker legt an der fehlenden Mount-Quelle ein **leeres
   Verzeichnis** an.
3. `post-create` läuft danach und will klonen — aber der Clone-Guard
   `[ ! -d projects/app ]` sieht das von Docker angelegte Verzeichnis
   und **überspringt den Clone**.

Ergebnis: Repo nie geklont, init.sql nie ausgeführt, `init.sql` ist
ein leeres Verzeichnis. Die Bind-Mount-Quelle muss **vor** dem
Container-Start existieren — der In-Container-Clone ist per Definition
zu spät.

## Entscheidung

Repos werden **host-seitig im `apply` geklont, vor `compose up`** —
nach dem Scaffold-Schreiben, in `<container>/projects/<path>/`.

- **Alle** Repos host-seitig (nicht nur die von Service-Volumes
  referenzierten) — einheitliches Verhalten, keine zwei Clone-Pfade.
  Die Checkout-Fidelity-Sorge (Zeilenenden, Exec-Bits), die historisch
  _für_ den In-Container-Clone sprach, ist mit dem WSL-Only-Pivot
  (ADR 0011) klein: der Host ist in allen drei unterstützten Setups
  (macOS / Linux / WSL) unixoid.
- **Idempotent**: ein vorhandenes `projects/<path>/` bleibt unangetastet
  (lokale Änderungen überleben Re-Apply).
- Der **In-Container-Clone in post-create bleibt** als Skip-Guard-
  Fallback (`[ ! -d ]`) — er überspringt schlicht, was host-seitig
  schon da ist. Kein Risiko, geringere Diff-Fläche.
- **Auth**: der Host-Clone nutzt denselben Host-git + Credential-Helper
  wie der bestehende Reachability-Pre-Flight (`git ls-remote`), der
  unmittelbar davor läuft und die Credentials bereits validiert hat.
  Kein eigener Credential-Pfad.

## Konsequenzen

- Service-Bind-Mounts aus Repo-Dateien (init.sql, Config) funktionieren
  wie erwartet — die Datei ist beim Container-Start da.
- Der Clone wird damit zur **echten host-seitigen Fail-Fast-Schranke**:
  schlägt er fehl, bricht `apply` vor `compose up` mit der echten
  git-Meldung ab. Das macht den separaten Reachability-Pre-Flight
  weitgehend redundant; er bleibt vorerst als schnelles Frühwarn-Signal
  bestehen, könnte aber später auf Warn-only reduziert oder entfernt
  werden.
- Der Host muss `git` haben (hat er — der Pre-Flight nutzt es bereits).

## Verworfen

- **Nur service-referenzierte Repos host-seitig klonen** — zwei
  Clone-Pfade, inkonsistent, mehr Komplexität für keinen Gewinn.
- **In-Container-Clone ganz entfernen** — größerer Eingriff in
  post-create + Tests für minimalen Gewinn; der Skip-Guard-Fallback
  kostet nichts.
