# Confluence style: a marker per section type

Shared rules for how the discovery artifacts (brief, persona, journey, design
brief) render in Confluence. Goal: **each section type gets its own marker** so
sections read distinctly - instead of monotone identical blocks. All in HTML+
(`contentFormat: html`).

Reader-visible labels below (e.g. the status-chip words) are shown in English as
reference; render them in the **output language**. Technical values
(`data-*`, `data-color`, macro/excerpt names) are never translated.

## Marker per section type

| Section type | Marker |
|---|---|
| Pitch / core statement | **info panel** (`panel-info`) |
| Problem / pain | **error panel** (`panel-error`, red) |
| Handoff / deliverable | **success panel** (`panel-success`, green) |
| Enumerable segments (audiences, personas) | full width, h3 + paragraph, **numbered circles, teal** |
| Numbered / sequential points (assumptions, steps) | full width, h3 + paragraph, **numbered squares, teal** |
| Negative enumeration, numbered | same shape, **red** instead of teal |
| Topic / capability list (core capabilities, principles) | **2 columns**, h3 with a **fitting topic emoji** |
| Exclusions (scope-out) | 2 columns, red **status chip** ("out") |
| Positive signals (success) | 2 columns, green **status chip** ("Signal") |
| Risks (journey) | 2 columns, yellow **status chip** ("Risk") |
| Plain prose (narrated journey) | no marker |

## Rules

- **Panels sparingly** - only the emotionally/action-charged sections (pitch,
  problem, handoff). Not every section a panel.
- **2 columns uniformly `data-breakout-width="760"`**; odd count → last column
  empty (`<p></p>`).
- **Topic emojis app-fitting** (not fixed). The numbered circles and squares are
  ordering markers: **circles** for enumerable segments, **squares** for
  sequential ones, so the two kinds stay apart at a glance.
- **Teal is the default colour.** A numbered enumeration that is negative takes
  **red** instead, in the same shape. A section that already carries a red status
  chip (scope-out, pain points) keeps the chip and takes no number - one marker
  per section, never two.
- The numbered markers come from **Atlassian's own emoji set**: 0 to 20, circle
  and square, ten colours. There is no Unicode character behind them, so write
  them as an emoji node with **all three attributes**:

      <span data-type="emoji" data-shortname=":1_one_circle_teal:" data-emoji-id="atlassian-1_one_circle_teal" data-emoji-text=":1_one_circle_teal:">:1_one_circle_teal:</span>

  **`data-emoji-id` is mandatory.** Verified on a live page: with all three
  attributes the marker renders as the coloured circle; with `data-shortname`
  alone, and with a bare `:shortcode:` in the text, Confluence renders the
  shortcode as literal text.

  The name is `<digit>_<number word>_<circle|square>_<colour>`, and the id is
  that name prefixed with `atlassian-`. So `:1_one_circle_teal:`,
  `:2_two_circle_teal:`, `:3_three_square_red:`. Colours: blue, gray, green,
  lime, magenta, orange, purple, red, teal, yellow. The full set:
  `curl -s https://api.atlassian.com/emoji/atlassian`.
- **Never as an anchor prefix.** A heading that is a deep-link target takes a
  topic emoji or none. These markers have no character, so there is nothing for
  the anchor scheme to encode.
- **In the Markdown fallback** (no Confluence) they do not exist: write a plain
  digit there.
- **Never an excerpt inside a panel** - the excerpt is transcluded, the panel
  would travel with it. Pitch-as-panel only on pages that are **not** transcluded
  (the brief). Persona/journey/design: core statement as a **named excerpt, plain text**.
- **Page-properties table** (header infobox / links): key-value, left column `<th>`.
- **No `<thead>`** in a page-properties table - both cells of a row in `<tbody>`,
  the left one a `<th>` (row header). A `<thead>` makes the first row render as a
  gray header row spanning both columns instead of a header column. A read can
  hand the first row back to you inside a `<thead>`; dissolve it on write-back.
  Observed as well (October 2026): on save, the **value** cell of the first row
  turned into a `<th>`. Writing the whole table anew, without `<thead>`, fixed
  it.
- **For a targeted edit, read the page as `html`.** A read in `markdown` carries
  no `data-local-id`, so there is nothing to aim an edit at.
- **A replaced node gets a new `data-local-id`** (observed October 2026 with
  `updateConfluenceContent`, `edits` and `replaceNode`). The id you aimed at is
  gone afterwards, and a follow-up edit against it misses. Either give the
  replacement a `data-local-id` of your own, or replace the stable parent - the
  table cell rather than the paragraph inside it.
- **When patching stored HTML, allow for attributes.** Saved headings and cells
  carry `data-local-id`, so a pattern like `<h2>Text</h2>` never matches - it has
  to be `<h2[^>]*>Text</h2>`. The same goes for `<td>`, `<p>` and `<li>`.
- **Read a page body into a file, not into the terminal.** From roughly 10 KB the
  output gets truncated, and a truncated body silently loses the part you were
  about to patch.
- **An update needs the page's current version.** Fetch it immediately before
  writing; a stale version is rejected.
- **A code block starts at column 0.** Confluence drops the leading whitespace
  of a code block's first line, masked as `&#32;` too, so a snippet that starts
  indented loses its structure: the first line moves left, the others do not,
  and whoever copies it gets broken yml. Write every code block from column 0
  and keep the indentation relative to that; when the snippet belongs at a
  deeper level of a file, the sentence before it says where.

## Diagrams

A diagram is the **overview for the human**, never the carrier of the content.
The tables stay authoritative: the planning skill reads them, and they survive
the Markdown fallback. Nobody should have to reconstruct a model from a picture.

### Where a diagram earns its place

A diagram is worth it from **three parts up**, where prose has to describe a
structure the reader then has to hold in their head. Below that it repeats a
sentence. The page has to stand without it: write the tables and the prose
first, and the picture on top.

### How it is made

The picture is a **PNG**, rendered by `scripts/diagram.mjs` from a JSON spec.
The script ships with the two skills that draw, the domain model and the
technical brief. The PNG is uploaded to the page as an attachment and embedded
as an image, not written as a Confluence macro. The PlantUML app used before
drew its SVG with Confluence's own font, so every name ran wider than its box,
attributes and verbs had to stay out, and the picture could not be opened full
screen. A PNG carries its font, needs no app, and Confluence opens it in its
image viewer with zoom.

The division of labour: **you decide the layout, the script draws the lines.**
Where a box sits is a judgement about what belongs together, so it is yours.
Routing the lines, keeping them apart, the small arc where two lines cross, the
check that no line runs through a box - that is mechanics, and the script does
it.

### The spec

```json
{
  "bands": [
    { "id": "content", "label": "Content", "tone": "blue" },
    { "id": "history", "label": "History", "tone": "amber" }
  ],
  "boxes": [
    { "id": "Skill", "band": "content", "row": 0, "col": 0,
      "attrs": [["name", "String"], ["theory", "String [0..1]"]] },
    { "id": "SkillAssignment", "band": "history", "row": 1, "col": 0,
      "attrs": [["skill", "Skill"], ["state", "SkillAssignmentState"]] }
  ],
  "edges": [
    { "from": "Skill", "to": "SkillAssignment", "fromCard": "1", "toCard": "0..*" }
  ]
}
```

| Key | Meaning |
|---|---|
| `bands[]` | Optional. `id`, `label`, `tone`. A band is a stripe across the full width with its label rotated along the left edge. Keep the label to one or two words; the explanation goes in the caption. |
| `boxes[].id` | Unique. Also the title unless `title` is set. |
| `boxes[].row`, `col` | Grid cell, from 0. One box per cell. |
| `boxes[].band` | Which band the box sits in. A band owns whole rows, as one continuous block: a row cannot mix bands, and an empty row between two rows of a band belongs to that band. |
| `boxes[].attrs` | Class boxes: `[name, type]` pairs, drawn as `name: Type`. |
| `boxes[].subtitle` | Component boxes: a line (or a list of lines) under the title, the technology. |
| `boxes[].shape` | `box` (default), `store` (a cylinder, for a database or object store), `external` (dashed, for a system outside the product). |
| `boxes[].tone` | Overrides the band's colour. |
| `edges[]` | `from`, `to`, `fromCard`, `toCard` (cardinality at each end), `label`, `arrow` (`to`, `from`, `both`), `kind: "inheritance"` (`to` is the superclass; no cardinalities). |

Tones: `blue`, `amber`, `green`, `purple`, `gray`.

A **self-reference** is an edge with `from` and `to` on the same box. It is
drawn as a loop on whichever side is free. The picture cannot show which end of
a loop is which, so keep one reading: `label` names the role, `fromCard` is how
many of that role one entity has, and `toCard` how many the role holds. People
Lead: `"fromCard": "0..1"` (a person has at most one lead), `"toCard": "0..*"`
(a lead leads any number). The relationship table's sentence says it in words.

### Laying out the grid

- **Start from the lines.** Go through the relationships and place first the
  pairs that should be joined by a straight line: a parent directly above its
  children, a chain in one row or one column.
- **The hub goes in the middle**, not to the edge. The entity with the most
  lines pulls the others around it.
- **One band per subject area**, stacked top to bottom. The entities that link
  two areas face each other across the boundary, in the same column, so the
  line between them runs straight down.
- **An empty cell beats a squeeze.** Room around a box is room for its lines.
- **Three lines on one side are one too many.** Each line end carries its
  cardinality, and three of them in a row make the reader work out which number
  belongs to which line. Move the box or a neighbour one column along, so the
  lines split across two sides. The report lists every such side under
  `hints`. At a hub with many relationships three ends on a side are often
  unavoidable; there the hint stays.

### Render, then look at it

```bash
node <skill-dir>/scripts/diagram.mjs model.json model.png
```

The first run installs the renderer (`@resvg/resvg-js`) into
`~/.cache/monoceros-discovery/` and needs the npm registry once; without it the
script stops after two minutes and says why. The script prints a report:
`crossings`, and `warnings` for a line through a box, two lines on top of each
other, two cardinalities on top of each other or on a box, and a label that
covers a cardinality or a box.

Then **open the PNG and look at it** before it goes anywhere. The report
cannot judge a picture:

- `warnings` must be empty.
- `hints` name the spots to look at first: a side where three lines meet, a
  line that takes a detour although a straight one was possible, and a label
  over 20 characters that pushes its two columns apart. Each one is a
  judgement, not an error: fix it when moving a box does, leave it when it does
  not.
- Crossings are fine, each gets a small arc. When roughly a third of the lines
  cross, or a line takes a long way round the picture, move a box and render
  again. Two or three rounds are normal.
- Every label and every cardinality readable, none on top of another.

Keep the spec file: it goes onto the page with the picture.

### What goes into the picture

- **Class diagram** (the domain model): every entity with its attributes as
  `name: Type`, references included (`skill: Skill`), and `[0..1]` after the
  type where the attribute table says *not mandatory*. The attribute table and the box say the same thing. A
  **cardinality at both ends of every line**. A **label** only where the line
  does not explain itself: a self-reference ("People Lead"), a second line
  between the same pair, a person in a role ("written by"). The verb of every
  other relationship lives in the relationship table. Enumerations stay in their
  table. **One band per subject area** of the domain model, ordered by the
  direction: the area the others read from at the top. Every entity sits in the
  band of the area that owns it.
- **Labels are short**, two or three words and about 20 characters. The label
  names the line; the explanation belongs in the relationship table or the
  caption. A long label on a straight line widens the gap between the two
  columns so it still fits, and the report names it under `hints`.
- **Component diagram** (building blocks): one box per part, the title the
  part and the `subtitle` its technology. `store` for a database, `external`
  for a system outside the product. `arrow: "to"` from the caller to the called,
  and a short `label` with the protocol or the purpose.

### Upload and embed

An attachment belongs to a page, so the page exists first. The order: write the
page with everything except the picture, render, upload, then add the figure to
the page.

The upload goes through `twg`:
`twg confluence content attachments upload --id <page-id> --file <png> -y`
returns the attachment id, and
`twg confluence content attachments get --attachment-id <att…> -o json`
returns `data.fileId`.

The figure, directly under the section heading, with the spec below it:

```html
<figure data-type="media-single" data-layout="wide" data-width="100" data-width-type="percentage"><div data-type="media" data-media-type="file" data-id="{fileId}" data-collection="contentId-{page-id}" data-alt="{caption}"></div><figcaption>{caption}</figcaption></figure>
<details><summary>{Diagram source}</summary><pre><code class="language-json">{the spec, HTML-escaped}</code></pre></details>
```

The spec on the page is what the next run renders from, not a spec rebuilt from
memory. **Updating** the picture: render from the edited spec and upload under
the **same file name**. Confluence keeps it as a new version of the same
attachment, but with a **new `fileId`**, and the page keeps showing the old
picture until the figure's `data-id` is switched to it. Verified.

**A page written before** still carries a PlantUML macro
(`data-extension-key` ending in `plantuml-fullpage-editor`). When the skill
updates that page, the figure replaces the macro; its PlantUML source is not
carried over, the spec is written from the tables.

**In the Markdown fallback** the PNG goes next to the Markdown file,
`![caption](model.png)`, and the spec under it as a `json` block.

## Deep links to a heading

A heading's jump mark cannot be read through any interface: the stored HTML
carries only `data-local-id` (ADF node ids), an outline listing gives headings
without anchors, and the available read formats are html, markdown and adf. The
anchor comes into being when the page is rendered. So build it from the heading
text, by rule:

1. Take the heading text exactly as it stands on the page, emoji and punctuation
   included.
2. Replace every space with a hyphen.
3. Percent-encode everything except ASCII letters, digits and the hyphen, byte by
   byte as UTF-8.

No page title, no prefix, and **do not lowercase it**. Nearly every other anchor
scheme (GitHub, MkDocs, Docusaurus) lowercases; this one does not, and a
lowercased anchor does not jump.

```
url = <page-url>#<anchor>
```

Verified against a real brief, one example per difficulty - plain ASCII, umlaut,
emoji with variant selector:

```
📤 Fertige Artefakte annehmen
  → %F0%9F%93%A4-Fertige-Artefakte-annehmen

🔒 Zugriff an der Adresse schützen
  → %F0%9F%94%92-Zugriff-an-der-Adresse-sch%C3%BCtzen

⌨️ Auf zwei Wegen veröffentlichen
  → %E2%8C%A8%EF%B8%8F-Auf-zwei-Wegen-ver%C3%B6ffentlichen
```

German umlauts, so the one error-prone step needs no arithmetic: ä `%C3%A4`,
ö `%C3%B6`, ü `%C3%BC`, ß `%C3%9F`, Ä `%C3%84`, Ö `%C3%96`, Ü `%C3%9C`.

An emoji's variant selector (U+FE0F) **stays in** and becomes `%EF%B8%8F` - the
third example above is in live use. Not verified by click: whether Confluence
normalizes it identically while rendering. If an anchor does not jump, hover the
heading in the UI, click the link symbol, copy the address, and follow the scheme
from it.

Because the anchor is derived from the text, **renaming a heading breaks every
deep link to it**. Headings that are link targets (a brief's core capabilities, a
persona's expectations) get renamed only deliberately, and the links that point
at them get corrected in the same pass.
