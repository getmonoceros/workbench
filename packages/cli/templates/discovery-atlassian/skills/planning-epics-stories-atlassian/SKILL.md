---
name: planning-epics-stories-atlassian
description: 'Derives the backlog - epics and stories - from the discovery (brief, journeys, personas, domain model, technical brief, design) through a guided dialog, and files them as Jira issues. Use this skill when someone wants to turn requirements into a backlog, epics, or stories, plan a project, or slice work for implementation. Goal: every story promises a function and carries everything needed to deliver it.'
---

# Planning: Epics & Stories

You derive the backlog from the discovery and file it in **Jira**. The journeys
give the direction; the backlog is their translation into work.

## Before you write anything

Read `references/discovery-rules.md`. It holds the rules that apply to every
discovery artifact; these three decide whether this skill's output is usable:

- **Invent nothing.** No requirement, property or condition of use that is not
  backed by the dialog or by an upstream artifact. When in doubt, ask; do not
  plausibly fill the gap.
- **Read the human's comments first** when the artifact already exists. Their
  comments are the work order, not your impression of the page.
- **Sections the human wrote are the calibration** for form, and they are not
  touched unasked. Propose a change and wait.

Findings that touch an upstream artifact do not get carried forward silently -
name them and work them in first (`discovery-rules.md`, "Feed findings back
upstream").

## What follows this skill

The backlog is the last discovery artifact, and the build starts next. A new
repository has neither a README nor agent instructions, so everything that holds
for every task would otherwise be repeated in every story: the conventions, the
domain vocabulary, where decisions go, the flow around the tracker. Name the
**project files** (`handoff-project-files`) when you finish, so they are written
once instead of story by story.

## What a story is

**A story promises a function, and contains everything needed so that the named
persona can carry it out on the running system afterwards.** Whatever is missing
for that belongs in the story: schema, endpoint, view, delivery, migration,
configuration. And nothing belongs in it that only a later story needs.

This is the rule the whole skill hangs on. Everything below serves it.

**The test, before you write a story down:** if this story were the last one
implemented before a demo, what could the persona do afterwards that they could
not do before? If there is no answer, it is not a story.

**No infrastructure issues.** Infrastructure is a consequence of a promised
function, never the subject of one. There is no project-scaffold story, no
database-schema story, no design-system story, no application-shell story. The
scaffold arrives with the first function. The schema arrives with the first
function that lists something. The design tokens arrive with the first screen,
in the amount that screen needs. Anything built ahead of a function is a guess,
and it gets corrected later at full price.

**No foundation epic, no walking skeleton, no special first story.** A story
with a special role is exactly the one that gets split by layer again next time.
Every story is the same kind of thing.

**Early stories are bigger, and that is fine.** The first function pays for
everything that does not exist yet. Do not split it to make it smaller: a small
story that delivers nothing is worse than a large one that delivers something.
The size drops on its own from the second story onward.

The first story with code also carries the **boundary check** the technical
brief names for the internal structure, when there is more than one subject
area. It is not a story of its own: it arrives with the first function, like
the scaffold. **A project that already has code** has no first story left: the
next story carries the check, and the plan names the existing violations it has
to fix, or to record in the check as known exceptions so that nothing new gets
past it.

**Own the whole promise.** If the summary promises X, the story owns every part
of X. "Replace a publication at the same address" owns the caching that makes
the new version actually appear. "Protect a publication with a password" owns
the page where the recipient types it in. A later story that repairs a promise
made earlier is proof that the earlier one was cut too thin.

**Not everything is a story.** Work with no product function at all (CI
pipeline, licensing, repository settings) becomes a **Task**: outside any epic,
no persona sentence, no Given/When/Then. Keep this set small. If something can
be justified by a function, it belongs in that function's story instead.

## Output language

Author the artifact - epic and story summaries, descriptions, acceptance
criteria, and section headings - in the **user's language**. Take it from the
conversation, or ask once at the start if it is unclear ("Which language should
the backlog be written in?"). This skill's own instructions and every technical
identifier stay as they are: Jira field names, issue-type keys, JQL,
status/workflow ids, and any `data-*`/macro identifiers are never translated.
See [`references/templates.md`](references/templates.md) for exactly what stays
verbatim.

## Procedure

### Step 0: Read the discovery and clarify the project

Read brief, journeys, personas, domain model, technical brief, and design.
Summarize which journeys and personas exist, and confirm. Read each journey's
**status** off the colour in the first row of its page properties
(`references/discovery-rules.md`, "A journey carries a status") and list the
journeys by status in the summary: that list says what this run will create.
If the user says a journey is in review or agreed, set its status on the
journey page and go on.

The **domain model is the reference for every story that touches data**: entity
names, attributes, states. Take them from there verbatim instead of inventing
your own, so the schema pieces that grow story by story fit together. It is a
reference, not a build order - there is still no schema story, and the schema
arrives with the first function that needs it. Ask for the **Jira project** (key).
Ask for the URL of the design deliverable (prototype/screens) if it is not in
the prompt - tool-agnostic (Figma Make, Claude Design, or other). You need it on
nearly every story, so ask once, up front.

**Existing backlog / second pass**: for each journey, check whether a fitting
epic already exists - the epic key linked on the journey page still **live** in
Jira, or an epic with a fitting summary in the project. If one lives, reuse or
update it, no duplicate; if its summary no longer matches the journey's title,
pull it to the title. If none exists (e.g. deleted in a test loop, key dead),
create a new one. The journey link is afterward **always** pulled to the key
from this run (see backfill), even if an old or dead key still sits there. A
journey that turned green under an epic from an earlier run gets its stories
under that epic.

**An epic left over**: its journey went back to blue, or the journey page is
gone. Tell the user the epic is left over and could be deleted, with its key.
**Never delete it yourself** - whether it goes is the team's call, and in most
Jira projects deleting is not permitted anyway.

### Step 1: Epics are journeys, one to one

One epic per journey. Nothing else becomes an epic: no architectural epic, no
technical epic, no foundation.

**Which journeys get one follows their status.** A blue journey gets nothing
yet; name it, it has not been put up for agreement. A yellow journey gets its
epic, so a team planning on a timeline sees it coming; its stories follow once
the journey is green. A green journey gets the epic and its stories.

**The epic's summary is the journey's title**, id included and without the
product prefix (the Jira project already names the product): the journey
`Handout | J-001: Ein neues Handout veröffentlichen` gives the epic
`J-001: Ein neues Handout veröffentlichen`, and `WP-04/1: …` stays `WP-04/1: …`.
The same name on both sides is what lets anyone go from the board to the page
and back without a lookup.

The epic stays lean - one or two sentences of prose (the essence), the **journey
as a card**, and epic-wide acceptance criteria. No persona, brief, or
technical-brief card on the epic; that context lives on the stories.

Label every epic `business`.

A story that serves two journeys hangs in the journey where the persona
**triggers** the function; the other journey is named as a card in the story's
business context.

### Step 2: Cut the stories

Per epic of a **green** journey, propose as many stories as the journey needs.
A yellow journey gets none yet: its details are still being agreed, and a story
cut from them is rewritten later. Cut along the function, never along the
layer. "Upload endpoint" plus "upload screen" is one story, not
two.

The **actionable open points of the technical brief** (set a config, mount a
realm, fix a port) are not stories. Each one goes into the story whose function
needs it, and becomes a Task only if no function needs it.

Each story has these sections (shape and formatting in
[`references/templates.md`](references/templates.md)):

1. **Story text**: "As a [persona] I want [capability], so that [value]." The
   capability is what the persona can do afterwards, not what gets built.
2. **### Business context**: a few sentences on the need behind it (**not** a
   one-sentence reference), then **persona** and **journey** each as an inline
   card with a bold label in front (`Persona:`, `Journey:`).
3. **### Implementation notes**: a plan as a list - everything needed to deliver
   the promise, across all layers (schema and migration, endpoint, view,
   delivery, integrations, edge cases, test level). One overarching task list,
   **not** a wall of prose. Plus the **Technical Brief** as an inline card with
   a bold label (`Technical Brief:`). With more than one subject area, name the
   **area the story changes**. A story that changes entities of two areas is a
   hint: either it is two functions, or one area changes its own data at the
   other's request. Say which, in the notes.
   Every **risk** on the journey page goes into the notes of the stories it
   bears on, said as what it means for this story: built to be reused, the
   volume kept configurable, the date that sets its place in the order.
4. **## Design**: the affected screen or prototype as a full **`blockCard`**.
   Every story that a person operates changes or uses a screen, so this section
   is the norm, not the exception. If you find yourself wanting to leave it out,
   check first whether the story is really a story. If the design deliverable
   has no screen for it yet, say so to the user rather than dropping the section
   silently.
5. **### Acceptance criteria**: checkbox list, Given/When/Then. Written from the
   persona's viewpoint: what they do and what they then see. "The address
   appears with a copy button", not "the response contains the address". Test
   levels belong in the implementation notes, not here.

### Step 3: Self-check every story

Walk the list once more and answer for each story:

1. What can the persona do afterwards that they could not do before? One
   sentence. No answer means it is not a story - fold it into the story that
   needs it.
2. Does any part of it exist only for a later story? Take it out.
3. Is any part of the promise in the summary missing? Pull it in.
4. Does it depend on a sibling story landing first? Then the cut is horizontal.
   Re-cut.

Report the result of this pass to the user before you create anything.

### Step 4: Order

Order stories by value and dependency. The order runs across the whole backlog,
not epic by epic: journeys interleave when one journey's function is worthless
without another's (a link nobody can open is not a delivered function). A hard
date among a journey's risks weighs in the order too.

### Step 5: Create in Jira

Use the available Atlassian tools and write **ADF**. The exact markup rules -
cards, checkbox criteria, colors, parent field, labels - are in
[`references/templates.md`](references/templates.md).

Then backfill the journey pages: each journey page arrives with two `to follow`
placeholders, and **planning is the only skill that fills them with real data**.
The procedure and the exact Confluence markup are in
[`references/journey-backfill.md`](references/journey-backfill.md).

Finally, tell the user the issue keys and the order.

If a tool cannot set a card or link, tell the user and hand them what they need,
rather than silently skipping it.

## Linking matrix (what belongs at which level)

| Level | Cards |
|-------|-------|
| Epic  | Journey |
| Story | Persona + Journey (Business context), Technical Brief (Implementation notes), Design screen (Design) |
| Task  | none |

The story carries its context cards **deliberately itself**, so whoever gets
only the story - an agent like Claude Code, or a human - knows from it for whom
and why, what to do, and where to look for details. That persona and journey
recur across sibling stories is intended: self-containment beats deduplication.

## Verification & `/goal`

The acceptance criteria are the basis for checking. During implementation the
agent runs under `/goal` with "the acceptance criteria of PL-X are met, tests
and build green" - derived from the criteria, not a separate field. Whether it
*looks* like the design screen is checked by a separate preview or human step.

## Style

- Propose rather than interrogate, one topic at a time.
- Author reader-visible content in the user's language (see Output language).
