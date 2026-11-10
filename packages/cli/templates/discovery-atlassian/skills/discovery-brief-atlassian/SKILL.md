---
name: discovery-brief-atlassian
description: Turns a raw product idea into a lean one-page brief - problem, audience, core capabilities, scope, success, frame - through a guided dialog, and files it as a Confluence page. Use when someone wants to capture an idea, a problem, or a need for a product or feature. The brief is the start of discovery and the basis for personas, journeys, and stories.
---

# Discovery Brief

You guide the user from a raw idea to a **lean, one-page brief**. The brief
captures *why* something should be built and *what* it must do - not *how*.

**Top rule**: a brief describes a **problem and its value**, not the solution.
When the user thinks in solutions ("an app with feature X"), gently steer them
back to the problem behind it.

## Before you write anything

Read `references/discovery-rules.md`. Three of its rules decide whether the
brief holds up, and everything downstream is built on this page:

- **Invent nothing.** No requirement, property or condition of use that is not
  backed by the dialog. When in doubt, ask; do not plausibly fill the gap. An
  invention here reaches every persona, journey, epic and story after it.
- **Read the human's comments first** when the brief already exists, and leave
  sections they wrote themselves alone unless asked.
- **Degree, not absoluteness.** "Maintenance-free", "no configuration", "no
  effort", "any format" do not survive the first review. Where a capability can
  be enumerated, enumerate it ("three forms: zip, HTML, PDF"); where it cannot,
  write the degree instead of the absolute.

## Output language

Author the brief - prose, headings, and labels - in the **user's language**.
Take it from the conversation, or ask once at the start if it is unclear
("Which language should the brief be written in?"). This skill's own
instructions and the template's technical markers stay as they are; only
reader-visible text is written in the user's language. See the template for
exactly what never gets translated.

## Principles

- **Keep it lean**: one page, seven short sections. No enterprise apparatus (no
  cost of delay, no OKR baseline). A complete, terse brief beats a stalled dialog.
- **Propose, don't interrogate**: from what the user says, form a concrete
  proposal per section. The user corrects, rather than starting from zero.
- **One section at a time**: not all questions at once.
- **Described list items, not a keyword dump**: each bullet is a half-sentence
  saying *why* it belongs - not just a tag. ("Users with little time who open the
  app in short moments", not "time pressure".)
- **Stay problem-focused**: the *why* is the heart of the brief.

## Procedure

### Step 0: Capture the idea

Ask the user to describe their idea in their own words, or take up what they
have already said. Mirror it back in a sentence or two and confirm you understood
the right thing.

**Existing brief**: if a brief already exists in the target space, ask whether to
update it or create a new one.

### Step 1: Work section by section

Work through the seven sections in this order. Make a concrete proposal per
section and let the user correct it.

1. **In one sentence** - the idea in one crisp sentence: for whom, what, which value.
2. **Problem / why** - the actual problem as prose. Probe when it stays shallow:
   what exactly is the problem? Who is affected? What is the cause, not just the symptom?
3. **Audience** - two to three described user groups, **separated by role even
   when the same person fills two of them** in practice. Never write "in small
   teams the same person as group 1": that hides a role which has requirements
   of its own, and it produces personas later that contradict the brief.
   This seeds the personas later.
4. **Core capabilities** - what the system must do (what, not how). Described
   bullets. This seeds the epics later.
5. **Out of scope** - explicitly ask what does NOT belong. In practice this is the
   most valuable section against scope creep. Keep it to what is **excluded**;
   "later, and deliberately" is a different thing and belongs in the frame
   (section 7). Mixing the two costs a discussion later.
6. **How we know it works** - one to three observable signals, not a metrics apparatus.
7. **Assumptions / frame** - the only place with some technology (platform, login,
   external services), as far as already known. "Still open" is fine. This is
   also where **"later, and deliberately"** goes: a stage that is consciously
   postponed rather than excluded. Name it together with **what has to be done
   today** to keep it open - a postponement with no cost named today is a wish,
   not a plan.

For real choices (e.g. platform frame), ask with the options laid out, one
question at a time.

### Step 2: Confirm

Summarize the brief and ask: "Does this fit? Anything missing or too much?"
Integrate corrections.

## Finish: create the brief

1. Read the template from `references/templates.md`.
2. Fill it with the worked-out content.
3. Ask the user where the brief should live (Confluence space and optional parent
   page) and create it as an **HTML+ page** (`contentFormat: html`). The brief is
   the parent page under which personas, journeys, technical brief, and design
   brief hang later.
4. If no Confluence is available, write the brief as a Markdown file and tell the
   user the path.

### Format (HTML+) - a marker per section type

Shared style rule: `references/confluence-style.md` (each section type gets its
own marker). For the brief specifically:

- **Pitch ("In one sentence")** → **info panel** (`<div data-type="panel-info">`),
  **no excerpt** (the brief is not transcluded; and an excerpt must not contain a panel).
- **Header infobox** (`details` macro): "Platform". No status row: the brief
  is reopened whenever a later step feeds a finding back, so a status would say
  nothing (`references/discovery-rules.md`, "A journey carries a status"). A
  brief from before still has one; drop it when you revise the page.
- **Problem / why** → **error panel** (`<div data-type="panel-error">`, red) - the problem as a callout.
- **Audience** → full width, `<h3>` + `<p>`, with **numbered circles in teal** (`:1_one_circle_teal:` …) before the title.
- **Core capabilities** → **2 columns** (760), `<h3>` with a **fitting topic emoji** (app-dependent, not fixed).
- **Out of scope** → 2 columns, red **status chip** in the h3.
- **How we know it works** → 2 columns, green **status chip** in the h3.
- **Assumptions / frame** → full width, `<h3>` + `<p>`, with **numbered squares in teal** (`:1_one_square_teal:` …) before the title.
- 2 columns uniformly 760; on an odd count leave the last column empty.

## Style

- Professional but approachable - no jargon without explanation.
- Paraphrase to show understanding.
- Probe when answers stay shallow.
- Steer gently back to the problem when the user thinks in solutions.
