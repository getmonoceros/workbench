# ADR 0013 — `monoceros apply` with phase display and log file

- Status: **accepted**
- Date: 2026-06-03
- Implemented in: 296dc39 (Step 1 — log file), cac6478 (Step 2 — spinner + `--verbose` + summary), follow-up commits for layout polishing + SIGINT handling.

> **Left open** (deliberately not built, no need):
>
> - **Pull skip via `docker image inspect`** — the spinner with the
>   `starting container…` phase already covers the pull case today; the
>   misleading `pulling…` phase no longer shows up separately anyway
>   (we start directly at `starting container…`).
> - **Container-side recovery on SIGINT** — the handler cleans up the
>   spinner, the log, and the cursor; the half-created Docker container
>   gets collected on the next `apply` via `--remove-existing-container`
>   / the Compose pre-cleanup. Active `docker rm -f` logic in the handler
>   would be race-prone (which container exists when), so it is
>   deliberately not implemented.

## Context

`monoceros apply` today runs `@devcontainers/cli` as a subprocess and
streams its output verbatim to `stderr`. Per apply, this produces a
block between the `▸ Container` and `▸ Next steps` sections consisting
of ISO timestamp lines, the full `docker run …` invocation including
metadata JSON, and the postCreate output — technically correct, but
unsorted and neither scannable nor helpful for the builder. An
up-front `ℹ` warning additionally announces today that the first apply
takes ~1–2 min; that is useful, but it also shows up every time on
success and competes visually with real hints.

In the **error case**, the actual error text gets lost in the same
stream — the `✘` message sits somewhere among a thousand timestamps.
There is currently no persisted log we could point the builder to
("take a look in here").

## Decision

We separate the **status display** (terse, in the TTY) from the **raw
log** (complete, on disk). Layout:

```
▸ Container

⠹ pulling runtime image…                       ← solange devcontainer-cli pullt
⠹ starting container…                          ← ab „Start: Run: docker run …"
⠹ running postCreate…                          ← ab „Running the postCreateCommand"
✔ container ready (1m 14s)

ℹ log: ~/.monoceros/container/<name>/logs/apply-<name>-2026-06-03T15-15-21.log
```

**Phase detection.** From the `@devcontainers/cli` output we map onto
a small state machine. Each state shows a short text next to the
spinner — that is the real added value: the builder sees _what_ is
happening right now, not just _that_ something is happening. Detected
phases (initial list, extensible):

| Trigger im Stream                              | Phase                      |
| ---------------------------------------------- | -------------------------- |
| `Pulling`/`Downloading` o.ä. vor `Start: Run:` | `pulling runtime image…`   |
| `Start: Run: docker build`                     | `building feature layers…` |
| `Start: Run: docker run`                       | `starting container…`      |
| `Running the postCreateCommand`                | `running postCreate…`      |
| `outcome":"success"` in der JSON-Endzeile      | → Erfolg                   |

Detection is deliberately **fragile-but-pragmatic**: if a match
breaks, we fall back to a generic "working…" text. The spinner stays
correct, only the label becomes imprecise. That is better than either
no text at all (boring) or fully parsed output (maintenance burden on
every devcontainer-cli update).

**Log file.** Path:

```
~/.monoceros/container/<name>/logs/apply-<name>-<ISO-datetime>.log
```

- Under `container/<name>/` — gets removed along with `remove`, fits
  the "everything under container/<name>" model.
- In the `logs/` subfolder — going forward, more audit logs will land
  there (see the backlog entry "Audit logging").
- The filename contains command + container name + timestamp, so that
  the path is self-explanatory even outside its directory
  (`cat ~/Downloads/apply-foo-….log` stays unambiguous when the builder
  copies the file somewhere else).
- Content: the full devcontainer-cli stdout/stderr, plus a short header
  at the start with the Monoceros version, container name, yml path,
  host info, and the **pull pre-warning previously shown in the TTY**
  (see below).

**Move the pre-warning.** Today's ℹ hint ("Pulling runtime image and
building feature layers. First apply takes ~1–2 min …") moves entirely
into the log. In the TTY it is redundant, because the spinner with
`pulling runtime image…` already makes visible what is happening.
Builders who want more context find the hint at the log header.

**Error case.** If `devcontainer-cli` aborts with a non-zero exit:

```
✘ postCreate failed (exit 1)

  npm ERR! code ELIFECYCLE
  npm ERR! errno 1
  …
  (letzte ~15 Zeilen stderr)

ℹ full log: ~/.monoceros/container/<name>/logs/apply-<name>-….log
```

We show the **tail** of the log (not the whole stream), so the
diagnosis is immediately visible but the scrollback is not buried. The
log path sits directly below it.

**`--verbose`.** `monoceros apply <name> --verbose` turns off the
spinner and streams the devcontainer-cli output raw to stderr as it
does today. Purpose: workbench-internal debugging, CI without a TTY,
bug reports against `@devcontainers/cli`. The log file is written in
this mode as well — whoever wants the raw stream usually also wants
the artifact.

**TTY detection.** Without a TTY (CI, piped stdout) we automatically
fall back to `--verbose` mode. Spinners in non-TTY streams are useless
and pollute logs.

**Pull vs. cached.** Before the `devcontainer up` we run
`docker image inspect ghcr.io/getmonoceros/monoceros-runtime:<tag>`.
If the image is present, we visually skip the `pulling…` phase — the
spinner starts directly at `starting container…`. This makes the happy
path quieter and avoids the misleading pull display when nothing is
pulled.

## Consequences

- The `▸ Container` section is four lines long on success (one per
  phase, one for the `✔`, one for the log path) instead of an
  indeterminate block.
- The audit path is established — `container/<name>/logs/` is the place
  where Monoceros records signs of life. Follow-up commands (`remove`,
  `add-feature`, `restore`) can log here too, without a new design
  decision.
- `--verbose` is the only supported way to watch the raw stream live.
  Whoever is used to it has to rethink; in exchange the default output
  becomes much more readable.
- The phase mapping is a small, isolable component that can be tested
  in Vitest with recorded devcontainer-cli outputs (we check the
  fixture files in).
- On a major update of `@devcontainers/cli` with changed log strings,
  the display degrades to the fallback text — the log file stays
  correct, no functional damage.

## Rejected

- **Full structured JSON capture of the devcontainer-cli output** via
  `--log-format json` (if ever stably available) — too little added
  value, too tight a coupling to the upstream format. Heuristic phase
  detection is enough.
- **Log file centrally under `~/.monoceros/logs/`** instead of
  per-container — logs then survive `remove`, but: (a) lifecycle
  question (who cleans up?), (b) finding them is harder without an
  index. Per-container is the simpler default; a central audit log can
  be added later without invalidating this ADR.
- **Spinner phases without descriptive text** — more robust, but boring
  and indistinguishable from a simple "working…" display. The whole
  point of the phases is the information about _what_ is running.
