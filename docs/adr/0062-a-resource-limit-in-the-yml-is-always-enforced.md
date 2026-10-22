# ADR 0062: A resource limit in the yml is always enforced

- Status: proposed
- Date: 2026-10-10
- Implements: #126

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

## Consequences

- Local behaviour does not change for a yml without `resources` and with the
  switch off.
- A builder who declares a figure that is too tight sees a named OOM kill
  instead of a silent exit 137.
- Unattended hosts plan with the same figures they enforce. On Kubernetes the
  figures map to requests and limits.
- Open, to settle with the implementation: the default per component, the
  exact yml key, the name of the switch, and the shape of the machine-readable
  output.
