# Template: Domain Model (HTML+)

In Confluence as **HTML+** (`contentFormat: html`). A marker per section type -
see `references/confluence-style.md`. Remove the `{...}` hints.

Page title: `{prefix}Domain Model`, where `{prefix}` is `{Product name} | ` or
nothing - the per-tree decision in `references/discovery-rules.md`. The artifact
words `Domain Model` stay **English** so titles are language-neutral; the content
follows the output language.

No meta preamble ("This document describes …"). The page opens with what the
domain is about; the functional context sits in the page tree.

## Output language - what to translate and what not

Render **prose and labels in the output language**: section headings, table
column labels, status-chip labels, and the descriptive sentences. The English
strings below are the **reference meaning**, not literal output.

**The names are the exception and default to English**: entity names, attribute
names, enumeration names, enumeration values and state values. The build reads
them from here and writes code. Only where the user explicitly asked for their own
language do the names follow it. Where an English name is not self-evident, the
entity's sentence names the business term.

**Never translate** (leave verbatim): every `data-*` attribute,
`data-extension-key` and extension type, macro parameter names (the excerpt name
`summary`, the `details` macro), `data-color` values, the keys of the diagram
spec, and the page-title artifact words (`Domain Model`). Data type
names (`String`, `Long`, `DateTime`, `Boolean`, `Decimal`, `Enum`) stay verbatim
too - they are read by the build, like the entity and attribute names above. Emojis are structural markers - keep them.

---

```html
<h2>{What the domain is about}</h2>
<div data-type="bodied-extension" data-extension-key="excerpt" data-extension-type="com.atlassian.confluence.macro.core" data-parameters='{"macroParams":{"name":{"value":"summary"}}}'><p>{One or two sentences: which things the product deals with and what holds them together.}</p></div>
<div data-type="bodied-extension" data-extension-key="details" data-extension-type="com.atlassian.confluence.macro.core"><table data-width="760"><tbody><tr><th><p><strong>{Product brief}</strong></p></th><td><p><a href="{brief-url}" data-card-appearance="inline">{brief-url}</a></p></td></tr><tr><th><p><strong>{Journeys}</strong></p></th><td><p><a href="{journeys-collection-page-url}" data-card-appearance="inline">{journeys-collection-page-url}</a></p></td></tr><tr><th><p><strong>{Technical brief}</strong></p></th><td><p><a href="{technical-brief-url}" data-card-appearance="inline">{technical-brief-url}</a></p></td></tr></tbody></table></div>
<h2>{The model}</h2>
<figure data-type="media-single" data-layout="wide" data-width="100" data-width-type="percentage"><div data-type="media" data-media-type="file" data-id="{fileId of the uploaded PNG}" data-collection="contentId-{page id}" data-alt="{The model of <product>}"></div><figcaption>{The model of <product>}: {one clause on the bands, e.g. the shared pool and the history per person}</figcaption></figure>
<details><summary>{Diagram source}</summary><pre><code class="language-json">{the diagram spec, HTML-escaped}</code></pre></details>
<h2>{Subject areas}</h2>
<table data-width="760"><thead><tr><th><p><strong>{Area}</strong></p></th><th><p><strong>{Purpose}</strong></p></th><th><p><strong>{Owns}</strong></p></th><th><p><strong>{Reads from}</strong></p></th></tr></thead><tbody><tr><td><p>{Area 1}</p></td><td><p>{one sentence}</p></td><td><p>{Entity, Entity}</p></td><td><p>{Area 2: what, and why - or "nothing"}</p></td></tr></tbody></table>
<h2>{Entities}</h2>
<h3>{Emoji} {Entity 1}</h3>
<p>{one sentence: what it is, in business terms}</p>
<table data-width="760"><thead><tr><th><p><strong>{Attribute}</strong></p></th><th><p><strong>{Type}</strong></p></th><th><p><strong>{Mandatory}</strong></p></th><th><p><strong>{Note}</strong></p></th></tr></thead><tbody><tr><td><p>{name}</p></td><td><p>{String}</p></td><td><p>{yes}</p></td><td><p>{one clause the name and the type do not already say}</p></td></tr><tr><td><p>{address}</p></td><td><p>{Address}</p></td><td><p>{yes}</p></td><td><p>{a reference: named after the role, typed with the entity it points at}</p></td></tr></tbody></table>
<h3>{Emoji} {Entity 2}</h3>
<p>{…}</p>
<table data-width="760">{…}</table>
<h2>{Relationships}</h2>
<table data-width="760"><thead><tr><th><p><strong>{Relationship}</strong></p></th><th><p><strong>{Cardinality}</strong></p></th><th><p><strong>{What it means}</strong></p></th></tr></thead><tbody><tr><td><p>{Handout} ↔︎ {Address}</p></td><td><p>{0..1 : 1}</p></td><td><p>{one sentence covering both directions, with the verb: a handout is reachable at exactly one address, and an address belongs to at most one handout}</p></td></tr><tr><td><p>{Artifact} ↔︎ {ZipArtifact, HtmlArtifact, PdfArtifact}</p></td><td><p>{Inheritance}</p></td><td><p>{…}</p></td></tr></tbody></table>
<h2>{States}</h2>
<h3>{Emoji} {Entity with a status}</h3>
<table data-width="760"><thead><tr><th><p><strong>{From}</strong></p></th><th><p><strong>{To}</strong></p></th><th><p><strong>{Trigger}</strong></p></th><th><p><strong>{Condition}</strong></p></th><th><p><strong>{Who}</strong></p></th><th><p><strong>{What follows}</strong></p></th></tr></thead><tbody><tr><td><p>{value}</p></td><td><p>{value}</p></td><td><p>{what the persona does}</p></td><td><p>{what has to hold}</p></td><td><p>{which persona or role}</p></td><td><p>{the rule that kicks in afterwards, or empty}</p></td></tr></tbody></table>
<h2>{Enumerations}</h2>
<table data-width="760"><thead><tr><th><p><strong>{Enumeration}</strong></p></th><th><p><strong>{Values}</strong></p></th><th><p><strong>{Used by}</strong></p></th></tr></thead><tbody><tr><td><p>{name}</p></td><td><p>{value, value, value}</p></td><td><p>{entity.attribute}</p></td></tr></tbody></table>
<h2>{Open points}</h2>
<section data-type="layout-two-equal" data-breakout="wide" data-breakout-width="760"><div data-type="column" data-width="50"><h3><span data-type="status" data-color="yellow">{open}</span> {Point 1}</h3><p>{which domain question is unresolved}</p></div><div data-type="column" data-width="50"><h3><span data-type="status" data-color="yellow">{open}</span> {Point 2}</h3><p>{…}</p></div></section>
```

Rules:

- **What the domain is about** = the **named excerpt `summary`**, plain text, no
  panel. It is transcluded, and a panel would travel with it.
- **One place per entity.** The `<h3>`, the sentence, and the attribute table sit
  together. Never a name list in one section and the attributes in another.
- **An entity without its references is incomplete.** Every relationship
  therefore appears twice: as an attribute row on the side that holds the
  reference (the n side of 1:n, the choosing side of n:m, in 1:1 the side that
  cannot exist without the other), typed with the other
  entity, and as a row in the relationship table. Both name the same
  cardinality: `FocusArea [0..*]` in the attribute row is the `0..*` beside
  FocusArea in the relationship row. It is not a foreign key: no ID, no `Id`
  suffix, the type is the entity.
- **Every attribute carries a note.** No blanks, no dashes, no exceptions: a
  blank cannot be told apart from a forgotten one, and the reader has to guess
  whether the attribute was thought about at all. This is the same rule as the
  described list items everywhere else in discovery - each entry carries its
  reason.
- **The note says what the name and the type do not**: where the value comes
  from, who sets it, where it surfaces, what happens when it is missing, what
  makes it unique. Not a restatement of the name. "The time of creation" for
  `createdAt` is filler; "set at upload, not at publication, and it orders the
  dashboard" is a note.
- **If you cannot write that clause, the attribute is not settled.** With
  `createdAt` it is usually open whether it is the upload or the publication
  moment and who sets it. That is a question for the dialog, not an empty cell.
- **A derived attribute names the function that shows or uses it** in its note.
  A computed value no journey or core capability reads is not in the model.
- **Attribute, state and enumeration tables keep a real `<thead>`.** These are
  data tables and want a header row. The no-`<thead>` rule applies only to the
  **page-properties** table at the top, which is key-value and needs a header
  **column** (`<th>` left, `<td>` right, everything in `<tbody>`).
- **The relationship table is the authoritative form**, and it is a table on
  purpose: an ASCII sketch like `Handout --1-- Address` leaves open which side the
  `1` belongs to. Here the two entities sit in **one** `Relationship` cell as
  `A ↔︎ B`, so the cardinality below reads onto them in the same order:
  `Handout ↔︎ Address` over `0..1 : 1`. The double-headed arrow also says
  that the row covers **both** directions, which is why one relationship is one
  row.
- **The `Cardinality` column is written exactly as the diagram writes it**, so the
  two cannot drift: an edge `{"from": "A", "to": "B", "fromCard": "1", "toCard": "0..1"}`
  becomes `A ↔︎ B` over `1 : 0..1`.
- **How to read it: the number beside a name says how many of *that* entity
  belong to one of the other.** That is the UML convention, and it is the opposite
  of what most readers guess. For `Handout ↔︎ Address` the correct value is
  `0..1 : 1`: the `0..1` sits beside Handout because one address belongs to at
  most one handout, and the `1` sits beside Address because one handout has
  exactly one address. It looks like "Handout is 0..1", which is exactly why the
  sentence is not optional. Get this backwards and the model says the opposite of
  what was agreed.
- An inheritance has no multiplicity and carries the word `Inheritance` instead,
  with the subclasses listed on the right of the arrow.
- Anyone who reads UML gets the precision from the cardinality; everyone else
  reads the sentence, which says the same thing in words. That is why the sentence
  is not optional.
- **One row per relationship, not per direction.** Both directions are one fact
  and belong in one row; two rows say the same thing twice and double the table
  (eleven relationships became twenty-two rows in the first draft).
- **The `What it means` sentence carries the verb and both directions.** "A
  handout is reachable at exactly one address, and an address belongs to at most
  one handout" is what a reader takes away; `1 : 0..1` alone is not.
- **The model section comes before the detail.** The diagram sits in its own
  `<h2>` directly after the page properties, because it is the overview and a
  reader wants it first. It carries every entity **with its attributes** and the
  **cardinalities** at both ends of every line; a verb only where the line does
  not explain itself. It answers which entities exist, what they carry and how
  many of each belong together. The notes, the verbs and the states are read off
  the tables. The spec sits in a collapsed section right under the picture, so
  the next run renders from it.
- **An enumeration and an inheritance must not express the same distinction.**
  `ArtifactType` with the values ZIP, HTML, PDF **and** the entities
  `ZipArtifact`, `HtmlArtifact`, `PdfArtifact` is a contradiction: one of the two
  is redundant. Subclasses when the forms behave differently, an enumeration when
  they only need to be named.
- **The page properties link three ways**: the brief above, the **Journeys
  collection page** as the source (one card, not one per journey), and the
  technical brief, which reads this model.
- The page has to stand **without** the diagram: when the picture could not be
  uploaded, the tables still carry the whole model.
- **The entity `<h3>` is a link target.** Journeys and stories deep-link to a
  single entity, so the anchor scheme in `confluence-style.md` applies, and
  renaming an entity means correcting the links that point at it.
- **Subject areas sit right after the model**, one row each. Every entity is
  owned by exactly one area, and that area is its band in the diagram. A
  single area is fine for a small product; the table then has one row.
- **"What follows" names the rule a transition sets off**, such as "the round's
  assessments become read only". Empty when nothing follows; never a restatement
  of the new state.
- **No state section for an entity without a status**, and no invented lifecycle
  to fill the template. Same for enumerations: no table if there are none.
- **Open points are domain questions only.** A technology question belongs in
  the technical brief - a section is the one place for its topic.
- 2 columns uniformly `760`; on an odd count leave the last column empty
  (`<p></p>`).
