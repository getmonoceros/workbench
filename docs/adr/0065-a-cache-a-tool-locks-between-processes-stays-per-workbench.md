# ADR 0065: A cache a tool locks between processes stays per workbench

- Status: accepted
- Date: 2026-10-22
- Relates to: [ADR 0015](0015-persist-ide-state-across-rebuilds.md) (volumes need
  node-owned mount points), [ADR 0022](0022-ssh-universal-ide-attach-point.md) (shared
  machine-wide volumes)

## Context

A Java workbench downloaded its whole Gradle setup again after every
`apply`: `~/.gradle` (wrapper distributions and the dependency cache, 571 MB
in a mid-sized Spring Boot project) lived in the container layer, and `apply`
recreates the container. Maven's `~/.m2/repository` and npm's `~/.npm` had the
same problem. Go did not: its build and module cache are machine-wide volumes
(`sharedCachePaths`), shared because they are content-addressed and safe for
concurrent use.

Gradle's cache is not. Gradle coordinates access to it between processes over
UDP, and its documentation says that only works when the processes can reach
each other, which is usually not the case for containerized builds. Two
workbenches building at the same time on one shared cache would wait on locks
they cannot see released.

## Decision

**A language declares a third kind of cache, `containerCachePaths`: a docker
volume per workbench**, named `monoceros-<name>-cache-<language>-<dir>`. It
survives `apply` like the shared caches, `monoceros remove` deletes it, and it
is never backed up, since the next build fills it again. A volume and not a
home bind, so its many small files stay off the host's file sharing.

- Java: `~/.m2/repository` shared machine-wide, `~/.gradle` per workbench.
- Node: `~/.npm` shared machine-wide. `node_modules` lives in the project
  checkout and needs nothing.

**The runtime gate moves from one version to one per language
(`cacheMinRuntime`).** A fresh volume takes the ownership of the directory it
is mounted on, so the runtime image pre-creates every cache path node-owned,
and a language's caches are mounted only from the runtime that does so: Go
from 1.6.2, Java and Node from 1.11.0. A language that declares a cache path
must name it; a test holds every descriptor to that.

## Consequences

- An existing workbench gets the Java and Node caches after
  `monoceros upgrade <name>` moves it to runtime 1.11.0. Until then nothing
  changes for it.
- The first build after the upgrade still downloads everything once; every
  build after that, and every `apply`, reuses it.
- A shared cache outlives the workbenches that filled it, like the Go caches.
  Reclaim one with `docker volume rm` when no workbench needs it.
