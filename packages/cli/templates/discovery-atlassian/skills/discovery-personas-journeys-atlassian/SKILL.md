---
name: discovery-personas-journeys-atlassian
description: Derives the personas and their customer journeys from an approved brief through a guided dialog and files them as linked Confluence pages under the brief. Use when someone wants to work out personas, user types, customer journeys, or the user's path through a product. The journeys are the basis for the later epics and stories.
---

# Personas & Journeys

You derive, from an approved brief, the **people who use the product and
their paths through it** - as a small, linked Confluence tree under the
brief. The personas grow out of the brief's audience; the journeys must
**together cover all of the brief's core capabilities**.

## Before you write anything

Read `references/discovery-rules.md`. It holds the rules that apply to every
discovery artifact, and four of them decide whether this skill's output is
usable:

- **Invent nothing.** No requirement, property or condition of use that is not
  backed by the dialog or by the brief. When in doubt, ask; do not plausibly
  fill the gap. An invention here reaches every epic and story built on it.
- **Read the human's comments first** when the page already exists. Their
  comments are the work order, not your impression of the page.
- **Sections the human wrote are the calibration** for form. Derive from them,
  carry the form to the other pages of the same type, and do not touch their
  sections unasked.
- **The page structure is closed.** No extra sections, lists, panels or
  tables. What turns up goes into the dialog, and step 4 gives it a
  destination.
- **The title prefix is a decision.** This skill creates the first pages below
  the brief, so it asks once whether titles carry the product name: redundant in
  a space of its own, essential in a shared one. `{prefix}` below stands for
  `<Product> | ` or for nothing.

Read `references/example-journey.md` and `references/example-persona.md` too -
a real, human-corrected persona and journey. They are the measure for form and
level of detail, not a content template.

## Output language

Author the personas and journeys - prose, headings, and labels - in the
**user's language**. Take it from the conversation, or ask once at the
start if it is unclear ("Which language should the pages be written
in?"). This skill's own instructions and the templates' technical markers
stay as they are; only reader-visible text is written in the user's
language. See the templates for exactly what never gets translated.

## Principles

- **One journey per flow**: a journey covers one self-contained flow that a
  persona runs from trigger to outcome. Split as soon as a flow has a trigger
  and an outcome of its own. The number of journeys follows from the number of
  flows, not from a target figure.
- **Propose, don't interrogate**: phrase personas and journeys as a
  concrete proposal that the user corrects.
- **Described list items, not a keyword dump**: each point is a
  half-sentence saying *why* it belongs.
- **Journey as a story, not a table**: narrated prose in four movements (see
  step 2) - no column jungle, no emoji curve.
- **Name the interactions, don't argue about them**: logging in, creating,
  switching on an option, uploading, copying, choosing - concrete actions
  belong in the story. What does not belong is reasoning about requirements or
  deriving a solution inside the narrative.
- **Write from the user's side only**. See step 2 for the patterns to refuse.

## Procedure

### Step 0: Read the brief

Read the brief (from Confluence, a file, or pasted in). Summarize the
**audience** and **core capabilities** briefly and confirm with the user.
Settle the **title prefix** here, once, if nothing exists below the brief yet
(`references/discovery-rules.md`); if pages are already there, read the answer
off their titles instead of asking. Settle the **journey ids** the same way
(`references/discovery-rules.md`, "Journey ids"): if the material numbers the
flows already - an order, an offer, a tender, an estimate - propose that
numbering once; otherwise `J-001`. Journeys that exist already show the scheme
in their titles.
Then work out **which flows** the product has - one journey per flow, so the
count comes out of the brief rather than out of a target figure. Announce the
sequence: personas → journeys → coverage check → feedback into the brief.

Two artifacts follow this one and both are derived from the journeys: the
**domain model** and, where the product has a user interface, the **design
brief**. They are independent of each other, so name both when you finish and
let the user pick the order (`references/discovery-rules.md` carries the whole
chain). The design brief is the one that gets skipped, because nothing depends
on it until planning asks for the prototype.

**Existing personas/journeys**: if some already exist, ask whether to
update them or create new ones.

### Step 1: Develop personas

Propose **one persona per audience group** of the brief. The brief separates
its groups by role, so a group that looks like the same person in practice
still gets its own persona - that role has requirements of its own. For each:

- **Name, age, short characterization** (e.g. "the overwhelmed
  collector") - becomes the page title
  (`{prefix}<Name>, <age> - <characterization>`).
- **Description** as short prose (one paragraph): context, situation, why
  the problem hits them. Goes into the excerpt macro later.
- **Expectations**: three to four, each with a **short title** and one or
  two sentences of reasoning. Each title becomes its own h3 heading, so a
  single expectation stays individually addressable - in the dialog, in a
  review comment, and as a link target.

Make sure the personas together motivate the core capabilities. Take form and
level of detail from `references/example-persona.md`. Paraphrase each persona
and get confirmation.

### Step 2: Work out journeys

One journey per flow. For each you collect:

- **Title**: `{prefix}{id}: <action>`. Under the standard scheme the id is
  `J-001`, `J-002`, … - three digits, numbered in the order the journeys were
  worked out. With an existing numbering it is that id, verbatim (`WP-04`),
  and a journey split in two keeps it with a suffix (`WP-04/1`, `WP-04/2`).
  The title names the **action** ("Ein Handout löschen"), never the story
  ("Der Abend, an dem es steht"). Nobody ever finds a literary title again.
- **Short summary** (one sentence) - goes into the excerpt.
- **Persona**: which persona runs through it (embedded via
  excerpt-include).
- **Addressed core capabilities** from the brief - as a list in the page
  properties, each one a **deep link** into its heading in the brief (anchor
  scheme in `references/confluence-style.md`). At the same time the bridge to
  the later epics.
- **Trigger**: the concrete **moment** that starts the journey. Two or three
  sentences: weekday, time, the state of things. The starting situation belongs
  in the journey text, not here - written in both places it stands twice.
- **Journey**: the narrated story, happy path, in four movements (below).
- **Pain points today**: three to four, each **short title + reasoning**.
- **What the app changes**: three to four, each **short title +
  reasoning**, one per pain point and in the same order.
- **Risks** (optional): what makes **delivering** this journey costly,
  uncertain or tight on time - not the user's view, which pain points and
  changes already carry. Typical: a hard date, a volume nobody has counted yet,
  a dependency on someone outside the team, a part that later journeys reuse
  and that therefore must not be built to be thrown away. Each a **short title
  + reasoning**; naming a consequence ("makes the export more work") is fine.
  Take them from the dialog or the material the user brings (an estimate, an
  offer, a tender). **No risk named, no section**: the page goes without it
  rather than carry an invented one or an empty heading. This is the one
  section written from the delivery side; the journey text above stays on the
  user's side.

The **epic only comes into being during planning** - "Epic in Jira" and
"Related work items" stay placeholders ("to follow") on the journey page
at first and are filled in then.

Every journey carries a **status**: blue Draft, yellow In review, green Agreed
(`references/discovery-rules.md`, "A journey carries a status"). This skill
writes blue. Planning reads it: no epic for a blue journey, the epic for a
yellow one, the epic and its stories for a green one. Set yellow or green only
when the user says so, and when you revise an agreed journey in substance, say
so and ask whether it goes back to yellow.

#### The journey text: four movements

The story is not one paragraph. It runs through four movements, each at least
one paragraph. `references/example-journey.md` shows all four on a real case -
read it before you write.

1. **The starting situation.** Who the person is, what undertaking they are in,
   who they work for, and **what the thing is** the journey is even about. A
   reader with no prior knowledge has to be able to follow. Unexplained
   particulars are the single most common reason a journey text is unusable.
2. **Why the product enters.** Said out loud, not assumed. What blocks the
   person without it.
3. **The actions, in order.** Complete, each one named: export, save, log in,
   create, upload, switch the option on, copy, paste, choose. No step left as
   understood.
4. **The outcome.** What is different because of it.

#### Write from the user's side only

Hard rule, and these are the patterns that came back from real runs:

- **No sentences about the system or which of its parts is responsible**
  ("that's X's job, not Y's").
- **No verdict on system behavior** ("there is no confirmation").
- **No invented feelings or motives** that do not follow from the persona.
- **No other persona** in a journey that is not theirs.
- **No rhetoric.** Refuse these openings outright: "What must not happen
  here ...", "This is the most dangerous moment ...", "and therein lies
  exactly ...".

### Step 3: Check coverage

Check: is **every core capability** of the brief touched by at least one
journey?

Coverage is allowed to spread over increments. A core capability without a
journey is a **finding to name**, not a defect - and never a reason to drop the
capability or to invent a journey for it. Say which capabilities are uncovered
and let the user decide whether a journey follows now or later.

### Step 4: Feed the findings back into the brief

Writing journeys regularly shows that the brief is wrong: a core capability is
missing, or one is wrong, or two are the same thing. In one real run this
happened four times, and the skill had no step for it.

So ask explicitly: **what did this change about the brief?** Collect the
changes, work them into the brief in one pass, and only then let the domain
model, the technical brief and planning build on it. A finding carried forward silently becomes a defect in
every artifact after it.

Get final confirmation.

## Finish: create the Confluence tree

Shared style rule: `references/confluence-style.md` (a marker per section
type - topic emojis on lists, status chips for pain/solution/risk, a named
excerpt without a panel).

1. Read the templates from `references/templates.md`.
2. Create two **container pages under the brief** (ask for the brief page as
   parent): one titled `{prefix}Personas`, one titled `{prefix}Journeys`.
   Each uses the
   **container-page template** (`references/templates.md`): a short intro
   paragraph in the output language, a divider, and the child-pages macro
   that auto-lists everything beneath it. These container pages **replace
   folders**: a page lists its children everywhere, a folder does not. If a
   collection page already exists under the brief, **reuse** it (don't
   duplicate) - including one still carrying the old, unprefixed title.
3. Create **one page per persona** as a child of the `Personas` collection
   page, and **one page per journey** as a child of the `Journeys`
   collection page - individual
   pages so each stays directly linkable by search.
4. Set the links: journey → its persona (plain page link, no anchor),
   persona → its journey, both point to the brief.
5. If no Confluence is available, write the pages as Markdown files and
   name the paths.

### Persona page: format (HTML+)

Create persona pages via the **HTML+ format** (`contentFormat: html`) -
macros and layouts work reliably that way, ADF by hand does not.
Structure:

1. **Excerpt macro, named `summary`**, around the description (one
   paragraph):
   `<div data-type="bodied-extension" data-extension-key="excerpt" data-extension-type="com.atlassian.confluence.macro.core" data-parameters='{"macroParams":{"name":{"value":"summary"}}}'><p>…</p></div>`.
   The name `summary` displays "Summary" instead of "Excerpt without
   title" and is the excerpt the journey pulls via excerpt-include. The
   name only takes effect **with the `macroParams` wrapper**.
2. **Page-properties macro** (`data-extension-key="details"`) with a
   key-value table: row "Involved in these journey(s)" → journey(s) as an
   **inline card**, row "Product brief" → brief as an inline card
   (`<a href="…" data-card-appearance="inline">…</a>`). This makes the
   fields evaluable via a page-properties report. **No `<thead>`** - both
   rows in `<tbody>`, the left cell of each row a `<th>` (row header). A
   `<thead>` makes the first row unstable (sometimes interpreted as a
   header spanning both columns).
3. **`<h2>Expectations</h2>`**.
4. The expectations as a **2-column layout**
   (`<section data-type="layout-two-equal" data-breakout="wide" data-breakout-width="760">`
   with two `<div data-type="column" data-width="50">`), each expectation
   an **`<h3>` (title with a fitting emoji in front)** + `<p>` (text).
   Choose the emoji per the app's topic and the expectation, not fixed.
   One h3 per expectation keeps it individually addressable - in a review
   comment and as a link target.

### Journey page: format (HTML+)

Also as HTML+ (`contentFormat: html`). Structure:

1. **Excerpt macro** (named `summary`) with the short summary.
2. **Page-properties macro** (`details`), table as a plain `tbody`. First
   row "Status" → a **blue status macro** with the Draft label in the output
   language (`<span data-type="status" data-color="blue">Draft</span>`); the
   colour is what other skills read. Then row
   "Epic in Jira" → the epic; as long as there is none, the text **"to
   follow"** (no link - planning turns it into the real Jira link); row
   "Addressed core capabilities" → **bullet list of the brief's addressed
   core capabilities** that the journey serves, each one a **deep link into
   its heading in the brief** (anchor scheme in
   `references/confluence-style.md`) - not plain text.
3. **`<h2>Persona(s)</h2>`** + **excerpt-include** that pulls the persona
   by page title - exactly as that page is titled, prefix or not, otherwise it
   finds nothing (embeds its named `summary` excerpt):
   `<div data-type="extension" data-extension-key="excerpt-include" data-extension-type="com.atlassian.confluence.macro.core" data-parameters='{"macroParams":{"":{"value":"{persona page title}"}}}'></div>`
4. **`<h2>Trigger</h2>`** + paragraph: the moment only, not the starting
   situation.
5. **`<h2>Journey</h2>`** + the narrated story in **four movements**, one
   `<p>` per movement or more (step 2). Not a single paragraph.
6. **`<h2>Pain points today</h2>`** + 2-column layout (760), each point
   `<h3>` with a **red status chip `Problem`** in front of the title
   (`<span data-type="status" data-color="red">Problem</span>`) + `<p>`.
7. **`<h2>What the app changes</h2>`** + 2-column layout, each point
   `<h3>` with a **green status chip `Solution`** in front of the title +
   `<p>`.
8. **`<h2>Risks</h2>`** + 2-column layout (760), each risk `<h3>` with a
   **yellow status chip `Risk`** in front of the title
   (`<span data-type="status" data-color="yellow">Risk</span>`) + `<p>`.
   **Only when a risk is named.** Without one the section is left out
   entirely. A risk named later adds the section in this place, after "What
   the app changes" and before "Related work items".
9. **`<h2>Related work items</h2>`** + a plain **`<p>to follow</p>`**
   placeholder.

**This skill only writes placeholders for the two epic-dependent spots.**
There is no epic yet, so the row "Epic in Jira" = **"to follow"** and the
"Related work items" section is a plain **"to follow"** paragraph. **Do not
build any Jira card, macro or table here, and never go searching Jira or other
pages for an epic** - there is none to look up yet. Planning fills both in when it creates the epic.

The `<thead>` note from above applies here too.

## Style

- Propose, don't interrogate; one topic at a time.
- Paraphrase to show understanding.
- Keep personas realistic, journeys concrete and narrated.
- **After every change to a journey text, re-check its derived sections**
  against it: does each pain point and each "what the app changes" point still
  describe something that happens in *this* story, and does it not already
  stand on another journey page? Moving a flow into its own journey is exactly
  where duplicates appear.
