# ADR 0038: A service may ship an executable into the container

- Status: accepted
- Date: 2026-07-29

## Context

Some services need an operation a compose file cannot express. Keycloak is the
case that forced it: its boot import only fills an EMPTY database, so an edited
realm file does nothing until `apply` recreates the service. Applying it to the
running server takes an admin-API call, which is a script, not configuration.

Without one, every project writes that script itself. The taskboard project did
exactly that, and its version deletes the realm and recreates it from the file,
with no guard against being pointed at a real environment.

## Decision

A service descriptor may declare `service.tools: [<file name>]`, with the file
next to the `component.yml` in the component's `tools/` directory. When that
service is configured, `apply` copies it into `<container>/.monoceros/bin/`,
mode 0755, and removes the directory again when the last contributing service
leaves the yml. The briefing names the exact call.

Three constraints the mechanism holds to:

- **Per service, per container.** A container without keycloak has no keycloak
  tool. Not baked into the runtime image, so the tool version follows the CLI
  that wrote the container instead of whatever image it happens to run, and no
  container carries tools for services it does not have.
- **No target parameter.** The tool reads the service's connection env
  (`KEYCLOAK_URL` and friends), so it can only ever reach this container's
  service. That is the guard the hand-written script lacked: an operation that
  replaces a realm must not be aimable at staging.
- **Only what the runtime image guarantees.** bash, curl and jq, so a tool needs
  no language runtime and works in a container of any stack.

Descriptor-declared and not a keycloak special case in the CLI, per ADR 0020:
adding a component stays a `component.yml` change with no code. Only plain file
names are accepted, so a descriptor cannot reach outside its own directory.

## Consequences

- **A destructive operation gets one obvious, documented path.** The briefing
  states what `keycloak-realm` costs (runtime state, sessions and generated
  client secrets are gone) and tells the agent not to write its own.
- **The tools live in the workspace, not on `PATH`.** The call is
  `.monoceros/bin/<tool>`, and the briefing spells it out. Putting them on
  `PATH` would need image support; not worth it for one tool.
- **`.monoceros/bin/` is Monoceros-owned** and rewritten on every apply, like
  the rest of `.monoceros/`. Edits there do not survive.
