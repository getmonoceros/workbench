# ADR 0066: A service descriptor keeps every version

- Status: accepted
- Date: 2026-10-23
- Relates to: [ADR 0021](0021-per-instance-service-connection-env.md) (the
  block travels with the instance),
  [ADR 0052](0052-upgrade-carries-a-service-image-fix-to-an-existing-workbench.md)
  (upgrade retags service images),
  [ADR 0063](0063-a-builder-can-keep-their-own-service-descriptors.md) (own
  service descriptors)

## Context

`add-service` bakes a service into the workbench yml: image, port, env,
healthcheck, `connectionEnv`. After that, the descriptor and the yml went
separate ways. `upgrade` rewrote only the `image:` line (ADR 0052), so a new
healthcheck or env key never reached an existing workbench. `apply` read the
briefing, the client packages and the other descriptor-only data by service
name from the current descriptor, so after a team changed a service its
workbenches got a briefing for a block they did not run, and an instance
renamed with `--as` got none of it (#139).

## Decision

**A service descriptor has a version, and every version stays as a file.**
`version:` is a whole number, 1 when absent. The current version keeps its file
name; older ones sit next to it with the version in the name:
`templates/services/rabbitmq@2.yml` beside `rabbitmq.yml`, and
`components/services/postgres/component@1.yml` beside `component.yml`. A file
`@n` must carry `version: n` and be older than the current one. Both loaders
leave out a file that does not fit and keep everything else, and `apply` and
`list-components` print a hint naming it: a version mix-up in a template
directory never stops anything, because a workbench may be meant to stay on
an old version. An older version whose current file is missing stays readable
for a workbench that names it; it is only absent from the catalog
`add-service` writes from. Whoever changes a descriptor copies
the current file to `@<its version>` first, then raises `version`. MCP servers
have no versions: the yml names them and carries no block that could fall
behind.

**The yml records the version a block came from.** `add-service`,
`init --with-services` and the shipped workbench templates write
`ref: <id>@<version>` right under the service's name. A service written by hand
has no `ref`.

**`apply` reads exactly that version.** Everything it takes from the
descriptor rather than from the yml comes from the version in `ref`, looked up
by the descriptor id: the briefing, the client packages, the deferred start,
the resource default, the deploy block, the VS Code recommendations. A renamed
instance therefore gets them too. `tools` stay looked up by name, because a
tool reads the connection env under the catalog name. A `ref` whose file is
not on this machine is a hint that names the file, never a stop: the block in
the yml is complete, so the service runs as it says, without the data from
that file. A newer version is a note.

**`upgrade` merges three states.** The block a version wrote depends only on
the descriptor and the service name, so it can be rebuilt. For a service whose
descriptor has a newer version, `upgrade` compares what the recorded version
wrote, the entry as it is, and what the newest version writes. A field only
the template changed takes the new value, a field only the builder changed
keeps theirs, maps are compared key by key and lists as a whole. When both
changed the same field differently, the entry stays as it is and `upgrade`
names the fields; `--replace=<service>` takes the newest version and drops the
edits. Changes are written field by field into the existing yml nodes, so
comments survive. Env keys a new version adds are seeded into `<name>.env`.

**An entry from before versions is stamped once.** When it equals what some
version of the descriptor with its image repository writes, apart from the
image tag, `upgrade` adds that `ref`, moves the image to that version's tag
(an older catalog wrote the old one, as ADR 0052 assumed), and merges from
there. An entry that matches no version keeps the image retag of ADR 0052.

## Consequences

- **Changing a shipped service means a new version.** A changed image tag,
  healthcheck or env in `components/services/*/component.yml` reaches an
  existing workbench only through the merge, and the merge only runs for a
  higher version. So the old file moves to `component@<n>.yml` and `version`
  goes up, image bumps included. A test pins the block every shipped version
  writes, so a change that skips this fails before it ships.
- **The builder's own image pin survives.** Before, a retag pulled every
  curated image back to the catalog's tag. Now an image the builder changed is
  a builder-only change and stays, unless the new version changes it too, which
  is a conflict they see.
- **A shared yml wants every version it names.** A workbench recording
  `rabbitmq@2` on a machine without `rabbitmq@2.yml` runs the block without
  its briefing and the rest, and `apply` says which file is missing. So the
  repository keeps old versions as long as workbenches use them.
- **`list-components --json` carries `version` per service**, and a workbench
  template lists a service with a `ref` as `<id>@<version>`.
