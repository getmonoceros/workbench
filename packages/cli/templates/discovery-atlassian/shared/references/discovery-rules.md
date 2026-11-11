# Discovery rules: what holds for every artifact

These rules hold for every discovery artifact - brief, persona, journey,
design brief, epic, story - and for every revision of one. Each was paid for
by a defect in a real run.

## Invent nothing

Never write a requirement, a property, or a condition of use into an artifact
that is not backed by the dialog or by an upstream artifact. When in doubt,
ask. Do not plausibly fill the gap.

This is the most expensive failure mode, because an invention in the brief
reaches every artifact built on it. Inventions observed in a single run: an
address that could be read aloud over the phone, handing the password over by
phone, an expiry date, a proof of origin on the password screen, quotation
marks around expectation titles, and an entire command-line application.

Plausible is not the test. Backed is.

## A proposal stands in the question

When you ask the user to confirm or correct something you propose (a sentence,
a section, a list of names), put the proposal into the question itself: the
text the question dialog shows. Never write it as a message just before the
question. Some agents draw the dialog over the text above it, and the user is
then asked to confirm something they cannot see.

If the proposal is too long for the question, show it on its own, and ask in
your next message, once the user has had it in front of them.

## No commercial internals

Discovery pages and Jira issues carry **no prices, no estimates, no effort
figures**, and no statement about what is priced and what is not. Dates and
the business goal of an increment are fine. So is naming a consequence in
words - "this makes the export more work" is a finding, not a figure.

The reason is where the pages live: often in a space the customer reads too.
A figure there is a commercial statement, made by whoever wrote the page,
outside the place where such statements are made. When the material a skill
reads contains figures (an estimate, an offer), take the content from it and
leave the figures behind.

## Page titles: the product prefix is a decision, asked once

The **brief always carries the product**: `<Product> | Brief`. It is the root of
the tree and the page everything else links to, so it has to be identifiable on
its own.

For every page **below** the brief - the collection pages, each persona, each
journey, the domain model, the technical brief, the design brief - the prefix is
a decision per tree:

- **A space of its own for this product** → **no prefix**. The space already says
  which product it is, and `Handout | Journeys` inside a Handout space repeats
  itself.
- **A space shared with other discovery trees** → **prefix**
  (`<Product> | <Page title>`). Without it a title like `Journeys`, or
  `J-003: Ein Handout löschen`, cannot be placed in a search across spaces.

**Ask once**, as a choice, in the first skill that creates a page below
the brief: "Should the pages carry the product name in their title? In a space
of its own it is redundant; in a shared space it is what makes them findable."

**Do not ask again in later skills.** Derive the answer from what is already
there: look at the titles of the pages that already hang under the brief. Do they
carry the prefix, then follow suit. Only when nothing exists below the brief yet
do you ask.

Whatever is chosen holds for the **whole** tree - a mixture is worse than either
option. And where one page references another **by title**, the reference carries
the title exactly as it is: the excerpt-include macro pulls a persona by its page
title, and a reference in the wrong form finds nothing.

The artifact words stay **English** (`Brief`, `Personas`, `Journeys`,
`Domain Model`, `Technical Brief`, `Design Brief`) so titles are
language-neutral. Everything that comes from the product itself - a persona's
name, a journey's action - follows the output language.

## Journey ids: an existing numbering is kept

A journey's title starts with its id: `J-001: <action>`. That is the standard
scheme, and it holds unless the flows are **already numbered** somewhere else -
in an order, an offer, a tender, an estimate. Then that numbering is the one
people check the work against, and a second one beside it makes every
conversation a translation.

- **Look for one, and propose it.** The skill that writes the first journey
  checks the material it has been given for a numbering of the flows. Found one:
  propose it once, as a choice, naming where it comes from. Found none,
  or the user declines: `J-001`, `J-002`, … in the order the journeys are
  worked out.
- **Do not ask again.** Later skills and later runs read the scheme off the
  journey titles that already exist, the way they read the title prefix.
- **The id is taken verbatim**, with its own letters, digits and separators:
  an offer that numbers its work packages `WP-04` gives `WP-04: <action>`.
- **A journey that has to be split keeps its id** with a suffix: `WP-04/1`,
  `WP-04/2`. The original numbering stays traceable. Under the standard scheme a
  new flow just takes the next free number.
- **A journey the source does not number** gets its id from the user, never
  from you: inventing a number inside someone else's scheme puts a line into it
  that nobody agreed to.

Wherever a skill refers to a journey by id, both forms are meant.

## Every reference is a link

A reference to a page that **exists** is a link - an inline card - never just
its title in text. And it runs **both ways**: where the template of the other
page has a field for the counterpart (a persona's "Involved in these
journeys", a journey's persona and capabilities), that field gets the link in
the same pass. Back-links go into those fields only; another page's prose is
not touched for them.

- **A page that does not exist yet** stays text. When it is created, the
  references to it become links in that same pass: search for its title or id
  on the pages of the tree.
- **Renaming or merging a page** carries every reference to it along in the
  same pass. Two break silently and need a look of their own: an excerpt-include
  finds its page by **title**, and a deep link finds its heading by **text**
  (`confluence-style.md`). A merged page leaves no reference behind pointing at
  the one that went. A renamed journey's epic carries its title as summary;
  that follows too, through planning (see "Jira issues are written by one
  skill only").

## Read the human's comments before you revise

If the artifact already exists and a person has reviewed it, **their comments
are the work order** - not your own impression of the page. Read them first,
then work.

Read all of them:

- **Inline and footer comments are separate.** A page with no footer comments
  can still be full of inline ones.
- **Open and resolved.** A resolved thread often carries the decision.
- **With replies.** Many interfaces leave replies out unless asked for them.

Take the full comment text, not a truncated table cell, and take the marked
selection with it. That selection can be a fragment from the middle of a word,
so use the page body as well to find the passage it belongs to.

## Sections the human wrote are the calibration

Where a person has written a section themselves, that section defines the
form: sentence length, level of detail, tone, how much gets spelled out.
Derive the form from it and carry it to the remaining pages of the same type,
instead of producing further variants of your own.

Do not touch their sections unasked. Propose a change and wait.

## The page structure is closed

The sections of a template are complete. No extra sections, lists, panels or
tables, however useful they look while writing.

What turns up while writing - a missing requirement, an open decision, a
contradiction - goes into the dialog with the human, not onto the page. The
next rule gives it a destination.

## Feed findings back upstream

Writing an artifact regularly exposes that an upstream one is wrong: the brief
is missing a core capability, or has one that is wrong, or has two that are
the same thing. In one run this happened four times.

So after the coverage check, ask explicitly: **what did this change about the
brief?** Collect the changes, work them into the upstream artifact in one
pass, and only then build the downstream artifacts on it. A finding you carry
forward silently becomes a defect in every page after it.

## Derived sections go stale

Sections derived from a narrative - pain points today, what the app changes -
are written once and stop being true the moment the narrative changes.
Observed: after one flow moved into a journey of its own, the same two points
stood on two pages, one of them with no connection to its own story.

After every change to a narrative, check its derived sections against it: does
each point still describe something that happens in **this** story, and does
it not already stand on another page?

## Where each artifact sits

The whole chain, so any skill can say what comes next instead of leaving the
user to guess:

```
brief
  → personas & journeys
      ├─ domain model → technical brief
      └─ design brief
  → planning (epics & stories), once both branches are done
      → project files (README, CLAUDE.md / AGENTS.md), the handoff into the build
```

The indentation carries the point: the technical brief hangs off the **domain
model only**. The journeys fork into two branches that never meet, neither waits
for the other, and planning is the only thing that needs both.

- The **domain model** feeds the storage decision in the technical brief: what
  has to be stored decides which storage, not the other way round.
- The **design brief** feeds the generation of the design system and the hi-fi
  prototype. The technical brief does **not** need it. Planning does: every story
  that touches a screen references its deliverable.

**Name the next step when you finish.** A skill that ends without saying what
follows leaves the user to reconstruct the order from six descriptions. Where two
artifacts are open, name both and let the user pick. The design brief is the one
that gets forgotten, because nothing depends on it until planning asks for the
prototype: a product with a user interface needs it, and if the technical brief
carries an open point about the shape of that interface, it needs it now.

## Jira issues are written by one skill only

**Creating a Jira issue, or changing what it says, goes through
`planning-epics-stories`. Never directly, from any skill and from any agent.**

That skill owns the shape of the backlog: one epic per journey, a story that
promises a function and carries everything needed to deliver it, no
infrastructure issues, the persona and journey cards, the backfill onto the
journey page. An issue created beside it obeys none of that, and nothing catches
it later - the backlog just quietly stops being consistent, one issue at a time.

The line runs between the **content** of an issue and its **progress**:

- Through the skill: creating an issue, its summary, its description, its
  acceptance criteria, its parent epic, splitting one into two.
- Not through the skill, because it is the development flow's own business:
  moving the status, assigning, and commenting on what happened.

So where something turns up that deserves an issue - an open point, a finding, a
piece of work the plan uncovered - name it and hand it to that skill. Do not file
it yourself.

## A write is never repeated to see its result

`twg` hands a large result over as a file. Instead of the JSON, its output then
starts with `output_files:` and names the file that holds it
(`stdout: "/tmp/twg/<time>/run.<id>/stdout.json"`). Read that file.

A write whose output you could not read may well have gone through. So never
run a create, an update or an upload again just to see what it returns. Look
up what is there first (the page under its parent, the issues by JQL), and go
on from that. In a real run an epic was created twice, and a test issue landed
in the backlog, because the output was cut off and the create ran again.

## A journey carries a status, and nothing else does

A journey page's properties open with a **Status** row: a status macro in one
of three colours. **The colour is the value.** The label follows the output
language, so a skill reads the colour and not the text.

| Colour | Label (English reference) | Means | Planning creates |
|---|---|---|---|
| `blue` | Draft | Written, nobody has looked at it yet. Every journey starts here. | nothing |
| `yellow` | In review | A human put it up for agreement: the goal and the scope stand, details are open. | the epic |
| `green` | Agreed | Agreed. | the epic and its stories |

- **A skill writes `blue`** when it creates a journey. It sets `yellow` or
  `green` only on the user's explicit word in the dialog ("J-003 is agreed"),
  never on its own judgement: whether something is agreed cannot be read off
  the page.
- **A `green` journey revised in substance** - a new step, another capability -
  is said out loud, with the question whether it goes back to `yellow`. A
  wording fix is not.
- **A journey page without the row** comes from before this rule. Ask the user
  which status it has and write the row; do not read a missing row as `blue`.
- **No other artifact carries a status.** The brief, the domain model, the
  design brief and the technical brief exist once per product and are reopened
  on purpose when a finding is fed back upstream, so a status there would say
  nothing. The domain model and the design brief name the journeys that are not
  `green` when they summarize their sources - what they take from those is
  provisional - and carry on.

## Subject areas grow with the journeys

A subject area (a bounded context) is a part of the domain with its own
language and its own reasons to change. It **owns** its entities: only it
creates and changes them, the others may read them. The domain model cuts the
areas, the technical brief decides what each becomes in code, planning names
the area a story changes, and the project files carry them to the agent that
builds.

- **An area is cut only from journeys that are worked out**: yellow or green
  (see "A journey carries a status"). A blue journey gets no area and no
  interface, only an open point.
- **Every pass over the domain model may add an area**, and none is settled
  ahead of the journeys that justify it.
- **Areas are confirmed with the user one at a time**, never accepted in bulk.
- **One area is a valid answer** for a small product. Say so rather than
  inventing a cut.
- **No circle between areas.** If A reads from B, B does not read from A.

## Never the em dash

Do not use the em dash character (U+2014) anywhere in what you write. Use a
normal hyphen with a space on each side, a colon, or a restructured sentence.
The same goes for the en dash (U+2013) used as punctuation: it is the same
character reached by a different route.

This holds for **everything the skills produce**: page prose, headings, table
cells, status-chip labels, diagram labels, Jira summaries and descriptions, and
the Markdown fallback. It is a house rule, not a matter of taste, and it is the
kind of thing nobody notices until it is on fifty pages.

Pages a person wrote themselves are not touched for this - see the calibration
rule above. The rule applies to what you write from now on.

## Degree, not absoluteness

Absolute promises do not survive the first review, and they damage the
credibility of the whole artifact. "Maintenance-free", "no configuration",
"no effort", "any format" all break on contact.

- Where a capability can be enumerated, **enumerate it**. "Three forms: zip,
  HTML, PDF" is testable and documentable; "any artifact" is not.
- Where it cannot, write the **degree** instead of the absolute: "little
  maintenance and an update you need not fear", not "maintenance-free".
