# Workbench-lokales `MONOCEROS_HOME`

Dieser Ordner ist die Wurzel für die Monoceros-Daten während der
Entwicklung des Workbench-Repos selbst. Alles drinnen ist ephemer und
gitignored — **außer** dieser README und der Sample-Config nebenan.

Beim Aufruf von `monoceros …` aus dem Workbench-Checkout sucht das
CLI ein File namens `monoceros-config.sample.yml` aufwärts vom
Binary; findet es dieses File, gilt der enthaltende Ordner als
`MONOCEROS_HOME`. Außerhalb des Workbench-Checkouts (z. B. nach
`pnpm install -g @monoceros/cli`) gibt es diese Marker-Datei nicht;
dann gilt die `MONOCEROS_HOME`-Env-Var oder der Fallback
`~/.monoceros`.

## Layout

```
.local/
├── README.md                          ← diese Datei (committed)
├── monoceros-config.yml               ← deine persönlichen Defaults (gitignored)
├── monoceros-config.sample.yml        ← Sample/Marker (committed)
├── container-configs/
│   └── <name>.yml                     ← yml-Profile (`monoceros init`)
└── container/
    └── <name>/                        ← materialisierte Dev-Container
                                         (`monoceros apply <name>`)
```

## Cleanup

Komplett aufräumen:

```sh
rm -rf .local/container .local/container-configs .local/monoceros-config.yml
```

Die committeden Dateien (README, sample) bleiben dabei erhalten,
solange du sie nicht explizit löschst.
