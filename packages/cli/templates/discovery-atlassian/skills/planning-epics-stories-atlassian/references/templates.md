# Templates: Epic, Story & Task (for Jira)

In Jira as **ADF**. Remove the `{...}` hints in the final version.

## Markup rules

- **References as ADF cards**, never as a raw URL or Markdown link. Prominent
  single references (journey on the epic, design screen on the story) as a full
  **`blockCard`**. Context references on the story (persona, journey, technical
  brief) as an **`inlineCard` with a bold label in front** (`Persona:`,
  `Journey:`, `Technical Brief:`).
- **Story to Epic via the Parent field**, not a generic issue link.
- **Epic label** `business`. There is no other epic label; the backlog has no
  architectural or technical epic.
- **Acceptance criteria as a checkbox list**: one ADF `taskList` with one
  `taskItem` per criterion. Given/When/Then each on its own line, separated by
  `hardBreak` inside the same `taskItem`; labels **bold and in color
  `#403294`**. Never use `blockTaskItem`: the Jira API accepts it, but the
  issue editor cannot load it and shows an empty description in edit mode.
  The exact shape is under [Acceptance criteria in ADF](#acceptance-criteria-in-adf).
- Headings as real headings. The heading is exactly "Acceptance criteria", with
  no addition like "(Definition of Done)".
- Descriptions structured, not a wall of prose.

## Acceptance criteria in ADF

A `taskItem` holds inline content directly (text, marks, `hardBreak`), never a
`paragraph`. One criterion looks like this:

```json
{
  "type": "taskList",
  "attrs": { "localId": "ac-list" },
  "content": [
    {
      "type": "taskItem",
      "attrs": { "localId": "ac-1", "state": "TODO" },
      "content": [
        { "type": "text", "text": "Given", "marks": [{ "type": "strong" }, { "type": "textColor", "attrs": { "color": "#403294" } }] },
        { "type": "text", "text": " {initial situation}" },
        { "type": "hardBreak" },
        { "type": "text", "text": "When", "marks": [{ "type": "strong" }, { "type": "textColor", "attrs": { "color": "#403294" } }] },
        { "type": "text", "text": " {the persona does something}" },
        { "type": "hardBreak" },
        { "type": "text", "text": "Then", "marks": [{ "type": "strong" }, { "type": "textColor", "attrs": { "color": "#403294" } }] },
        { "type": "text", "text": " {what they can see or do afterwards}" }
      ]
    }
  ]
}
```

Further criteria are further `taskItem` entries in the same `taskList`, each
with its own `localId`.

If the tool takes Markdown instead of ADF and converts it, a multi-line
`- [ ]` item can come out as `blockTaskItem`. After creating an issue, read
its description back; if it contains `blockTaskItem`, rewrite it in the shape
above before moving on.

## Output language - what to translate and what not

Render **all reader-visible text in the output language** (the user's language):
issue summaries, description prose, section headings, and list items. The
English strings below are the **reference meaning**, not literal output.

**Never translate** (leave verbatim): Jira field names (Summary, Parent, Label),
issue-type keys, JQL, status/workflow ids, the label value `business`, ADF node
types (`blockCard`, `inlineCard`), the color `#403294`, any `data-*`/macro
identifiers, the BDD keywords Given/When/Then, and the artifact-type names
(Persona, Journey, Technical Brief, Epic, Story, Task).

---

## Epic - one per journey, lean

- **Summary**: {the journey's page title, id included, without the product prefix - e.g. `J-001: Ein neues Handout veröffentlichen`}
- **Label**: `business`

{One or two sentences of prose: the essence of the epic.}

{Journey as blockCard}

### {Acceptance criteria}

- [ ] {epic-wide criterion}
- [ ] {…}

---

## Story - one promised function, everything needed for it

As a {persona} I want {capability the persona can carry out afterwards},
so that {value}.

### {Business context}

A few sentences on the need behind it - enough that the business sense is clear
(not a one-sentence reference).

**Persona:** {persona as inline card}

**Journey:** {journey as inline card}

{If the story serves a second journey: that journey as a further inline card
with its own bold label.}

### {Implementation notes}

Plan as a list - everything needed so the persona can carry the function out,
across all layers. Whatever is missing for that belongs here:

- {Subject area: the area whose entities this story changes - only with more than one area}
- {Data: schema, migration, persistence}
- {Service: endpoint, validation, authorization}
- {View: the screen(s) the persona operates, states, keyboard use}
- {Delivery: routing, caching, headers - whatever the promise depends on}
- {Integrations: auth, storage, external services}
- {Edge cases}
- {Risks: what a risk named on the journey page means for this story - only where the journey names one}
- {Test level}

**Technical Brief:** {as inline card}

## {Design}

{The affected screen or prototype as a full `blockCard` (URL from the prompt or
asked from the user, tool-agnostic). This is the norm: a story a person operates
touches a screen. If the design deliverable has no screen for it yet, say so to
the user instead of dropping the section.}

### {Acceptance criteria}

From the persona's viewpoint: what they do, and what they then see. Not
"the response contains the address" but "the address appears with a copy
button". Given/When/Then bold and in color `#403294`, each on its own line:

- [ ] **Given** {initial situation}
  **When** {the persona does something}
  **Then** {what they can see or do afterwards}
- [ ] **Given** {…}
  **When** {…}
  **Then** {…}

---

## Task - work with no product function

For CI, licensing, repository settings and the like. No epic, no persona
sentence, no Given/When/Then.

- **Summary**: {what gets done}

{A few sentences: what is to be done and why it is needed. A short list of
concrete steps if that helps.}

{Technical Brief as inline card, if it is the source of the task.}
