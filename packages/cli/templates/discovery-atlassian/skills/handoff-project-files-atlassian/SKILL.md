---
name: handoff-project-files-atlassian
description: Writes the files a new repository needs before the build starts, from the finished discovery - the README for people, and the agent instructions (CLAUDE.md for Claude Code, AGENTS.md for OpenCode and Copilot) with the stack, the conventions, the domain vocabulary and the development flow. Splits public from internal content along the project's constellation. Use this skill when someone starts building a project whose discovery is done and the repository is still empty of both, or when the brief or the technical brief changed and the files have to follow.
---

# The files a new repository starts with

You write two things, both **derived** from the discovery and never invented:

- **The README**, for people. What this is, for whom, how to get it running.
- **The agent instructions**, for whichever agent works the repository next:
  `CLAUDE.md` for Claude Code, `AGENTS.md` for opencode. Everything that would
  otherwise be repeated in every single story belongs in there.

They share everything that makes this skill hard - the constellation, the split
between public and internal, the confirmation - and differ only in audience. The
README is read by strangers, the agent instructions by a machine that trusts
them.

**Both files are written in English**, unlike the discovery pages, unless the
user asks for their language. They go into the project, where they sit next to
the code, the ADRs and the commit messages, and the README of a public repository
is read by people who never saw the discovery.

## Where this sits

Planning is the last discovery step; this is the handoff into the build. It needs
all of it: the brief, the journeys, the domain model, the technical brief, the
design brief, and the backlog. Run it again whenever the technical brief or the
domain model changes, because a stale guide is worse than none: an agent trusts
it.

## Before you write anything

Read `references/discovery-rules.md`. Two of its rules decide the outcome here:

- **Invent nothing.** Every line traces back to an artifact or to the dialog. A
  convention you made up becomes a convention the whole project follows, and
  nobody will remember it was never agreed.
- **Read the human's comments first** when the file already exists, and leave
  what they wrote themselves alone.

## Step 0: Which agent, and what is already there

Take the agent from the technical brief's features: `claude` means `CLAUDE.md`,
`opencode` and `copilot` mean `AGENTS.md`. Claude Code next to one of the
others means both files, with the same content.

If either file already exists, read it and say what you intend to change. Never
overwrite a section a person wrote. A README in particular stops being yours the
moment the project has one: from then on you propose, you do not rewrite.

## Step 1: The constellation, asked once

Two questions decide what goes where. Ask them as a choice, in one
go, and never assume the answer:

**Is the code public?** and **is the discovery public? is the tracker public?**

That yields four cases, and only the split differs:

| Code | Discovery | Tracker | Where things go |
|---|---|---|---|
| public | public | public | one committed file, everything in it |
| public | internal | public | two files; the flow stays public |
| public | internal | internal | two files; **the flow goes private** |
| private | internal | internal | one committed file, everything in it |

The first and the last case are the simple ones: there is nothing to hide from
anyone who can read the repository, so one `CLAUDE.md` in the project root
carries the lot and is committed.

The middle two need the split, and the rule that decides every line is:

**What describes the code is public. What names your instance, your customer or
an internal artifact is not.** Space keys, page URLs, the Jira project key, the
board, the customer's name: those go into `.claude/CLAUDE.md`
(`.opencode/AGENTS.md` for opencode; Copilot reads `.claude/CLAUDE.md` too),
which is gitignored and machine-local.

And the harder half of the same rule: **no public artifact may point at an
internal one.** Not the README, not the docs, not a comment in the code, not a
commit message. A link into a customer's Confluence space in a public repository
leaks the relationship even when the space itself stays closed. Add the private
file to `.gitignore` in the same step, and say in the public file that internal
coordinates exist without naming them.

## Step 2a: The README

Short, and only from the artifacts. A new project's README earns nothing by being
long:

- **Name and one sentence**, from the brief's pitch.
- **The problem and who has it**, two or three sentences from the brief. This is
  the part a stranger reads and the part no generator can invent.
- **Status**, honestly: early, and what does not exist yet.
- **Getting it running**: the requirements and the commands, from the technical
  brief and its `monoceros` sketch. Where the project is not a workbench, the
  plain steps.
- **Configuration**: the environment variables the technical brief names. The
  names, never the values, and never a default that would work in production.
- **License**, only where it is decided. Where it is not, say the gap out loud
  rather than choosing one: nobody may pick a licence on the user's behalf.

**The README is the most public file in the repository**, so the rule about
internal artifacts binds hardest here: no link into Confluence, no Jira key, no
customer name, not even in a "see also".

## Step 2b: The agent instructions

Only what holds for **every** task, and only what is in the artifacts:

- **What the product is**, two sentences from the brief. An agent that knows the
  purpose makes better small decisions.
- **The stack**, from the technical brief: languages, services, what the app
  brings itself as a dependency.
- **The cross-cutting conventions**, verbatim from the technical brief:
  authentication, validation, the error shape, how identifiers are formed,
  migrations instead of an init script.
- **The domain vocabulary**: the entity names with one line each, and the naming
  language the domain model settled on. This is what stops every story from
  inventing its own words.
- **The structure**, when the domain model has more than one subject area: one
  module per area with the entities it owns, the direction between them, and
  the rule that an area changes only its own entities. The agent reads this
  file while building, not Confluence; without it the areas stay on a page and
  never reach the code.
- **Where decisions go**: `docs/adr/`, numbered, and the rule that a recorded
  decision is not reopened.
- **How the work is run**: servers through `monoceros-ctl` and
  `.monoceros/launch.json`, never a bare shell start; the shape of an acceptance
  command, which runs the boundary check from the technical brief where there
  is one.
- **The development flow** - but **only where the tracker is public**. Where it
  is not, the whole flow goes into the private file (step 3), and this section
  says nothing about it.
- **Who writes issues** - in the same file as the flow, public or private, since
  it is about the same tracker. The rule is in the next step; it is not optional,
  because this file is the only way the roles ever learn it.
- **Out of scope**, from the brief's exclusions. The fence saves more time than
  any instruction.

One gap is worth naming rather than filling, and **only where the code is
public**: how contributions from outside are handled is nowhere in the discovery,
not in the brief and not in the technical brief. It is a product decision, so do
not invent one. Say that the file is silent on it until it is decided, and leave
it at that. Where the code is private the question does not arise and the note
does not belong.

Keep it short. Every line an agent has to read before every task costs on every
task, so a sentence that only sometimes applies belongs in the story, not here.

## Step 3: The development flow, proposed and not assumed

This is the most opinionated part of the guide and the part the user is most
likely to want different, so it is **proposed**, the same way step 1 asks about
the constellation: put the twelve steps in the message, then ask
whether to take them as they are or change them. Nothing goes
into the file before that answer.

It is written for a Jira tracker; where the tracker is GitHub, the same steps
hold with issue state and a project column instead of a board status.

**Where the settled flow lands depends on the tracker, not on the code.** Count
what the steps touch: the branch name comes from the issue key, the assignment,
the board status and the comment are all tracker. In a public repository with an
internal tracker that is either useless or revealing, so the whole flow goes into
the private file.

And **do not generalise it to make it publishable**. "Set the issue to the
in-progress status" in a repository with no visible issues is an instruction into
the void, and it still describes how your agent works against your tracker. The
choice is where it goes, not how vague it is. In the private file it may be fully
concrete: the real status names, the real project key, the `twg` commands.

The draft pull request is the one step that looks public and is not: in this flow
it is the place your review happens, not a contribution path.

**The flow moves issues, it does not write them.** Assigning, the status changes
and the comment in step 8 are its own business. Creating an issue or changing
what it says is not, however obvious the need looks in the middle of a task: that
goes through `planning-epics-stories`, or the backlog stops being consistent one
issue at a time.

**This sentence has to be in the file, and it has to address every agent, not
just the one reading the flow.** The planner that wants to split a story, the
implementer that trips over work nobody filed, the reviewer that finds a defect:
none of them knows that `planning-epics-stories` exists. The role prompts cannot
carry it either - they ship with the CLI to every workbench, including the many
that have no Jira and no discovery - so the project's own instructions are
the only channel. Write it as a rule for anyone working this repository: **name
new work to the user, do not file it.**

It goes in the same file as the flow: public where the tracker is public, private
where it is not.

1. Create a branch from the issue: the issue key plus a slug from its title.
2. Open a draft pull request, where the code host supports one.
3. Assign the issue to the current user.
4. Move it to **In Progress**.
5. Implement.
6. When the implementation stands, tell the user what to test and check.
7. Once they confirm, commit.
8. Comment on the issue with what changed, including the commit id.
9. Push, which updates the pull request.
10. Move the issue to **In Review** and take the pull request out of draft
    (`gh pr ready <n>`). The two belong together: a board that says "in review"
    next to a draft that says "not yet" is the one contradiction this flow is
    built to avoid, and it leaves the maintainer guessing which one is true.
11. Ask **once**, and list what the yes covers: the merge, deleting the pull
    request branch, switching to main locally and pulling there, and moving the
    issue on. Write the actual commands into the question. One yes authorises the
    whole sequence, and the steps then run without asking again.
12. Move the issue to **Done** and unassign it.

Two properties are worth naming in the file rather than leaving implicit,
because they are what makes the flow safe: the agent never merges and never
closes without the user's word (steps 6 and 11), and every state change on the
board is paired with something that actually happened in the repository. A board
whose states move on their own is a board nobody trusts.

**Two gates, not eleven.** The flow asks the user twice, at step 6 and at step
11, and each question covers everything that follows it until the next gate.
Write that into the file: without it, an agent facing four outward actions in one
step will reasonably ask before each one, and asking again after a yes is not
caution, it is the yes not being worth anything.

**Who does the outward steps.** The roles have a guard that denies the
implementer anything leaving the machine - it commits, it never pushes. So the
push, the merge and the cleanup belong to the session that coordinates the
roles, not to a role. Say so in the file, or the coordinator looks for a role to
hand it to and finds none.

If the session still asks per command after the yes, that is not the flow but the
session's permission mode. The fix is an allowlist in the project's
`.claude/settings.json`, and it is the user's call, not something this skill
writes for them: `gh pr merge` and `git push` are exactly the operations someone
may want to keep confirming. Name it as an option, with what it would allow.

Where the user wants it different, take their version. This is a proposal, not a
policy.

## Step 4: Confirm, before anything is written

Summarize what is about to be written: which files at which paths, the
constellation that decides the split, the sections and which artifact each one
came from, and the flow as it now stands. Show the README in full - it is short
and it is the file strangers read. Then ask once whether it fits and integrate
the corrections.

This step exists because the previous three each produce content and none of
them is a decision the user saw in full. Without the gate, a skill that says
"propose" in prose gets read as "write" by anyone following the numbered
structure - and the flow, which was meant to be a proposal, lands in the file
unasked.

## Step 5: Write the files, and report

Write the README and the public agent instructions to the project root, the
private instructions to `.claude/` or `.opencode/`, and add the private path to
`.gitignore`.

**Without a filesystem** - the chat has none - give the content as Markdown in
the message, one block per file with its target path above it, plus the line to
add to `.gitignore` where a private file was produced. Same content either way;
only the placing is the user's.

Then report in the user's language: which files, which constellation, and one
line per section on where its content came from, so a wrong line can be traced
back to the artifact that produced it rather than argued about.

## Style

- Derived, never invented. When something is missing, name the gap instead of
  filling it.
- **Nothing is written before step 4.** Assembling content is not the same as
  agreeing it.
- Short. This file is read before every task.
- No em dash (`references/discovery-rules.md`).
