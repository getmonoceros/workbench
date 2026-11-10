# Templates: the files a new repository starts with

Markdown files in the repository, not Confluence pages. Remove the `{...}` hints.

- `README.md` in the project root, committed, for people.
- The agent instructions in the project root: `CLAUDE.md` for Claude Code,
  `AGENTS.md` for OpenCode and Copilot, same content.
- The **private** instructions in `.claude/CLAUDE.md` (or
  `.opencode/AGENTS.md`), added to `.gitignore`, only in the two constellations
  that need them.

## Output language

**English**, unless the user asks otherwise. This is the exception among the
artifacts: it lives in the project, beside the code, the ADRs and the commit
messages, and the next agent to work the repository reads it. Entity and
attribute names come from the domain model as they are, and the technical
markers (paths, commands, tool names, `docs/adr/`, `monoceros-ctl`) stay
verbatim.

Where the user does want their language, the entity names still do not follow -
they are what the build compiles against.

---

## README.md

```markdown
# {Product}

{The brief's pitch, one sentence.}

## What this is for

{Two or three sentences from the brief: the problem and who has it. The part a
stranger reads.}

## Status

{Early, and what does not exist yet. Honest, not modest.}

## Getting it running

{Requirements, then the commands. From the technical brief and its monoceros
sketch, or the plain steps where the project is not a workbench.}

## Configuration

{The environment variables the technical brief names, with what each one is for.
Names only. No values, and no default that would work in production.}

## License

{Only where it is decided. Where it is not, this section is absent and the gap is
reported to the user instead - a licence is not something to pick on their
behalf.}
```

Rules for the README:

- **The most public file in the repository.** No link into Confluence, no Jira
  key, no customer name, not in a "see also" either.
- **Short.** A new project earns nothing by a long README, and every line has to
  come from an artifact.
- **It stops being yours** the moment the project has one. From then on propose,
  never rewrite.
- **Contributions from outside** are not covered by the discovery. Where the code
  is public, say the file is silent on it until it is decided. Where it is
  private, the question does not arise.

---

## The public agent instructions

```markdown
# {Product}

{Two sentences from the brief: what this is and for whom.}

## Stack

- {language, from the technical brief}
- {service} - {what it holds}
- Brought by the app itself, not by the workbench: {frameworks and libraries}

## Conventions

{Verbatim from the technical brief's cross-cutting conventions, one line each.}

- **{Authentication}**: {…}
- **{Validation}**: {…}
- **{Error shape}**: {…}
- **{Identifiers}**: {…}
- **{Migrations}**: {…}

## Domain vocabulary

{The entity names from the domain model, one line each. Names in the naming
language the model settled on; the sentence in the output language.}

- `{Entity}` - {one line}
- `{Entity}` - {one line}

## Structure

{Only with more than one subject area in the domain model; otherwise drop the
heading.}

- `{module}` - {area}: owns `{Entity}`, `{Entity}`
- `{module}` - {area}: owns `{Entity}`; reads `{Entity}` from `{module}`

Direction: `{module}` → `{module}`, never back. An area changes only its own
entities and reads the others' through what the owning module offers. The
boundary check ({the check from the technical brief}) runs in the acceptance
command; do not switch it off to get a story green.

## Decisions

Under `docs/adr/`, numbered. A decision recorded there is settled: build on it,
and if it has to be overturned, say so and name the ADR by number.

## Running the work

- Servers are declared in `.monoceros/launch.json` and driven with
  `monoceros-ctl start|stop|logs`. Never a bare shell start, never `pkill`.
- An acceptance command has to be able to fail: {the shape this project uses}.
  {With more than one subject area: it runs the boundary check too.}

## Development flow

{The twelve steps, or the user's version of them - **only if the tracker is
public**. Where the tracker is internal, this heading is absent from the public
file and the flow lives in the private one.}

{Addressed to every agent working this repository, not only to the one reading
the flow, and in the same file as the flow: this flow moves issues along, it
never creates one and never rewrites what one says. Work that turns up during a
task is named to the user and filed through the planning skill, so the backlog
keeps its shape. Without this paragraph no agent knows that skill exists.}

## Out of scope

{The brief's exclusions, one line each. What is deliberately postponed says so
and names what keeps it open.}
```

## The private file

Only in the two constellations with internal discovery or an internal tracker.
Nothing in here is referenced from any committed file.

```markdown
# {Product}: internal references

Machine-local, gitignored. Nothing that is committed points at anything in
here.

## Discovery

- Brief: {URL}
- Journeys: {URL of the collection page}
- Domain model: {URL}
- Technical brief: {URL}
- Design brief: {URL}

## Tracker

- {Jira project key}, board {name}
- {The statuses in the order the flow uses them}

## Development flow

{Where the tracker is internal, the twelve steps live here and nowhere else, and
here they are concrete: the real status names, the real project key, the actual
commands. Absent from this file when the tracker is public, because then the flow
is in the public one.}

## Access

{How the container reaches these: the tool and the variables it needs, never
the values.}
```

Rules:

- **The split is decided by one rule**: what describes the code is public, what
  names the instance, the customer or an internal artifact is not.
- **The development flow follows the tracker, not the code.** Issue keys, board
  statuses, assignment and issue comments are all internal artifacts, so with an
  internal tracker the whole flow is private. Generalising it is not a
  compromise: an instruction about issues in a repository without visible issues
  helps nobody and still describes how the agent works against that tracker.
- **No public file points at a private one.** Not the README, not the docs, not
  a code comment, not a commit message. The public file may say that internal
  coordinates exist; it does not say where.
- **Credentials never appear in either file**, not even in the private one. It
  names the variable, never the value.
- **Every line traces to an artifact.** A convention that is in neither the
  technical brief nor the dialog does not go in, however sensible it looks.
- **Short.** This file is read before every task in the repository.
