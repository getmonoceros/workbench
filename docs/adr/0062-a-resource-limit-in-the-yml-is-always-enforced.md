# ADR 0062: A resource limit in the yml is always enforced

- Status: accepted
- Date: 2026-10-10, accepted 2026-10-22
- Implements: #126
- Relates to: [ADR 0061](0061-machine-wide-settings-live-in-the-global-env.md)
  (where the switch lives),
  [ADR 0063](0063-a-builder-can-keep-their-own-service-descriptors.md) (a
  builder's own service descriptor)

## Context

Workbench containers run without memory or CPU limits. Locally that means one
service or one build can take all the memory Docker has, which on macOS and
Windows is the fixed memory of the Docker VM, shared by every workbench that
is up.

A host that runs workbenches unattended, one per task, needs two more things.
It has to know what a workbench will use before it builds it, so it can turn
the task away when it is full. And the figures it planned with have to hold,
or one workbench starves the others.

Docker Compose enforces `deploy.resources.limits`. Verified with Compose
v5.3.0: `memory: 256m` and `cpus: "0.5"` show up as `memory.max` and `cpu.max`
in the container's cgroup, and a process that exceeds the memory limit is
killed with exit 137 and `State.OOMKilled=true`. Compose itself prints only
`exited with code 137`.

## Decision

**A figure that appears in the yml is enforced. Nothing in the yml is
decoration.**

- **Defaults live in the catalog.** Each service descriptor, and the
  workspace, carries a default memory and CPU figure. `init` and `add-*` do
  not write them into the yml.
- **The yml declares only overrides.** A workbench may set `resources` for the
  workspace and per service. A declared figure becomes a Compose limit on
  every `apply`, locally and on unattended hosts alike.
- **Enforcing the catalog defaults is a machine-wide switch** in
  `monoceros-config.env`, off by default. With it on, every container without
  a declared figure gets its catalog default as a limit, and `apply` prints
  the effective limit of each container.
- **An OOM kill names its cause.** `apply`, `run` and `status` read
  `State.OOMKilled` and say which container hit which limit, in line with the
  rule that errors name the cause.
- **`apply` warns before it cannot fit**: when the enforced memory of a
  workbench exceeds what Docker reports as available.
- **The effective figures are available machine-readably**, so an unattended
  host can admit or reject a workbench before `apply`.

### How it is settled

- **The yml key** is `resources:` with `memory` (Docker notation with a
  required unit, `512m`, `2g`, at least `6m`) and `cpus` (a number). At the top
  level it is the workspace's; in a service entry it is that service's. A
  declared field overrides the default field by field, so `memory` alone keeps
  the default `cpus`. No `workspace:` block: one key does not need a block.
- **The switch** is `MONOCEROS_ENFORCE_DEFAULT_LIMITS=true` in
  `monoceros-config.env`, read from there only, like `MONOCEROS_HOST_PORT`.
- **The defaults** come from what idle workbenches use, with room above:

  | Container                          | memory | cpus |
  | ---------------------------------- | ------ | ---- |
  | workspace                          | 4g     | 2    |
  | mssql                              | 2g     | 2    |
  | keycloak, mysql, mongodb, pgvector | 1g     | 1    |
  | postgres, rustfs                   | 512m   | 1    |
  | redis                              | 256m   | 0.5  |
  | caddy, mailpit                     | 128m   | 0.5  |

  SQL Server refuses to start below 2000 MB and idles at 1.1 to 1.3 GiB, so
  2g is its floor. The workspace has no descriptor, so its default is a
  constant in the CLI. A service descriptor carries its default as
  `service.resources`, descriptor-only like `deferStart`. An instance finds it
  by name first and then by exact image, so `add-service postgres --as
analytics` still gets the postgres default.

- **A service without a default.** A builder's own descriptor may carry
  `resources` too. With the switch on, a service that ends up with no memory
  figure at all fails `apply`, naming the service and both places to set one:
  a host that promised a limit on every container must not start one without.
  A missing `cpus` is allowed, since CPU is shared, not used up.
- **Image mode.** A workbench without services has no compose file, so the
  workspace limit goes on the run args as `--memory` and `--cpus`.
- **Detecting an OOM kill.** Verified on Docker 29.6.1 with cgroup v2: Docker
  sets `State.OOMKilled=true` when only a child process is killed and the
  container keeps running, so a build that blows up in the workspace is
  caught. A container restart clears the flag, and a service with
  `restart: unless-stopped` that hits its limit loops (`oom`, `die 137`,
  `start`). `status` therefore reports a `restarting` container with the flag
  set as a crash loop with its restart count. `apply` looks after the start
  when a limit is set or the start failed, `run` when the command ends with 137. Every message names the container, the limit and the key to raise.
- **The fit warning** compares the sum of this workbench's memory limits with
  `docker info`'s `MemTotal`. Other running workbenches are not counted: a
  limit is a ceiling, not a reservation, and admission on an unattended host
  is that host's decision, made from the machine-readable output.
- **The machine-readable output** is `monoceros status <name> --json`: per
  container `memory`, `memoryBytes`, `cpus` (`null` without a limit),
  `running` and `oomKilled`, plus the total `memoryBytes`. It works before the
  first `apply`, computed from the yml, the catalog and the switch. Admission
  counts memory only.

## Consequences

- Local behaviour does not change for a yml without `resources` and with the
  switch off.
- A builder who declares a figure that is too tight sees a named OOM kill
  instead of a silent exit 137.
- Unattended hosts plan with the same figures they enforce. On Kubernetes the
  figures map to requests and limits.
- A hand-written service is unlimited on a laptop and an `apply` error on an
  enforcing host until someone gives it a figure.
