# ADR 0044: The git identity comes from declared sources only

- Status: accepted
- Date: 2026-08-01
- Builds on: [ADR 0031](0031-pat-based-repo-auth.md) (the env file as the
  home for per-builder credentials)

## Context

Commits made inside a container need `user.name` and `user.email`. Apply
resolves them and writes `<container-dir>/.monoceros/gitconfig`, which the
container's `~/.gitconfig` includes.

Two defects in that mechanism surfaced within a day of each other, and
they turned out to be the same mistake seen from two sides.

**Setting an identity did not work.** The env variables `GIT_USER_NAME`
and `GIT_USER_EMAIL` only took effect through a `git.user: ${GIT_USER_NAME}`
line in the container yml, and `init` writes that line only for
`--with-repos`. A workbench without repos, which is the common shape for
an AI-agent container, had no path from the env to the container. The
builder set both variables globally, applied, and nothing happened.

**Removing one did not work either.** `collectGitIdentity` read the
`.monoceros/gitconfig` it had written on the previous apply and used those
values as a fallback source. A file that is both output and input keeps
itself alive: commenting the variables out and applying left the container
committing under the old name, with `monoceros check` correctly reporting
nothing wrong, because the identity really was still there.

Both come from treating "wherever we can find a value" as the goal. The
workbench's own model says something narrower: the yml and the env are
the source of truth, the container is derived from them.

## Decision

The identity resolves from **declared sources only**, most specific first:

1. `repos[].git.user` for a single repo
2. the container yml's `git.user`
3. `GIT_USER_NAME` / `GIT_USER_EMAIL` from the merged env, global
   `monoceros-config.env` and the container's own `<name>.env`, with no
   yml entry required
4. `defaults.git.user` in `monoceros-config.yml`
5. the host's `git config --global`
6. a one-time prompt

Every one of those is a file the builder can edit. `.monoceros/gitconfig`
is **written on every apply and never read**, so removing an identity from
where it was declared removes it from the container.

The prompt writes its answer into an env file, global or per container,
never into a yml. A name and an address are personal data; the env files
are the gitignored half and the yml is the part a builder shares. With
the generated file no longer a source, an unsaved answer would also be
gone by the next apply, so the prompt has to land somewhere real.

Collection itself is unconditional. The container's `~/.gitconfig`
includes `.monoceros/gitconfig` whether or not anything was resolved, so
not writing the file leaves a dangling include; a workbench with no repos
used to land exactly there. What the old conditions still gate is the
_prompt_: a container that never mentioned git is not interrogated about
it, and the other sources still resolve in silence.

## Consequences

An identity behaves like every other setting: declare it, apply, it is
there; remove it, apply, it is gone. `monoceros apply` says so when
nothing resolved, and `monoceros check` reports a container that cannot
commit, because the failure otherwise appears as "Please tell me who you
are" halfway through an agent's task.

`defaults.git.user` stays a source and is still read. Monoceros no longer
writes it, so `writeGlobalDefaultGitUser` and the yml navigators built for
it are gone. `setContainerGitUserInDoc` stays: `add-repo` still uses it to
scaffold the `${VAR}` placeholders.

Someone who had answered the prompt with "keep as-is" kept their identity
only in `.monoceros/gitconfig`. That option is gone, and such an identity
is not carried over: the next apply asks again and writes the answer to an
env file. Losing a value that no file declared is the point of the change,
not a regression.

The rule generalises beyond this feature. **A file Monoceros generates is
never also an input.** Where a generated artifact feeds back into the next
run, state accumulates that nothing declares and nobody can remove without
editing generated output by hand.
