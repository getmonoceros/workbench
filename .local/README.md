# Workbench-local `MONOCEROS_HOME`

This folder is the root for Monoceros data while developing the
workbench repo itself. Everything inside is ephemeral and gitignored —
**except** this README and the sample config next to it.

When you run `monoceros …` from the workbench checkout, the CLI
searches upward from the binary for a file named
`monoceros-config.sample.yml`; if it finds that file, the containing
folder is treated as `MONOCEROS_HOME`. Outside the workbench checkout
(e.g. after `npm install -g @getmonoceros/workbench`) this marker file
does not exist; in that case the `MONOCEROS_HOME` env var applies, or
the fallback `~/.monoceros`.

## Layout

```
.local/
├── README.md                          ← this file (committed)
├── monoceros-config.yml               ← your personal defaults (gitignored)
├── monoceros-config.sample.yml        ← sample/marker (committed)
├── container-configs/
│   └── <name>.yml                     ← yml profiles (`monoceros init`)
└── container/
    └── <name>/                        ← materialized dev containers
                                         (`monoceros apply <name>`)
```

## Cleanup

Clean up completely:

```sh
rm -rf .local/container .local/container-configs .local/monoceros-config.yml
```

The committed files (README, sample) are kept, as long as you do not
delete them explicitly.
