# Templates: Personas & Journeys

Both as HTML+ (`contentFormat: html`) with macros/layout. Remove the
`{...}` hints in the final version.

## Output language - what to translate and what not

Render **all reader-visible text in the output language** (the user's
language): section headings (`<h2>`/`<h3>` text), table row labels,
status-chip labels, link text, and prose. The English strings below are
the **reference meaning**, not literal output.

**Never translate** (leave verbatim): every `data-*` attribute,
`data-extension-key` and extension type, macro parameter names (the
excerpt name `summary`), `data-color` values, JQL, `cloudId` and
datasource ids, the page-title artifact word (`Journey`), and the
artifact-type names (Persona, Journey, Brief, Epic) wherever they appear as
a heading or reference label. Emojis are structural markers - keep them.

---

## Container pages: `Personas` and `Journeys` (HTML+, `contentFormat: html`)

Two grouping pages **under the brief**, one per collection, that replace
folders. Each = a short intro paragraph (in the output language) + a divider +
the child-pages macro that auto-lists the pages filed beneath it. Titles are
`{prefix}Personas` and `{prefix}Journeys` - the artifact word stays English.
Reuse an existing collection page instead of creating a duplicate, whichever
form its title is in.

Intro reference text (render in the **output language**):

- **Personas**: {Personas are fictional but realistic descriptions of a product's typical users. They capture goals, needs, behaviors, and problems, and help teams in discovery structure assumptions, prioritize problem spaces, and decide from the user's perspective rather than purely the company's.}
- **Journeys**: {User journeys describe the steps users take to reach a goal with a product or service. They surface the touchpoints, expectations, questions, and hurdles along the way, and help teams understand user needs, spot weak points, and derive targeted improvements for a coherent experience.}

```html
<p>{intro paragraph, in the output language - Personas resp. Journeys reference above}</p>
<hr>
<div data-type="extension" data-extension-key="children" data-extension-type="com.atlassian.confluence.macro.core" data-layout="default" data-parameters="{&quot;macroParams&quot;:{&quot;depth&quot;:{&quot;value&quot;:&quot;1&quot;},&quot;allChildren&quot;:{&quot;value&quot;:&quot;true&quot;},&quot;style&quot;:{&quot;value&quot;:&quot;h3&quot;},&quot;sortAndReverse&quot;:{&quot;value&quot;:&quot;&quot;},&quot;excerptType&quot;:{&quot;value&quot;:&quot;simple&quot;},&quot;first&quot;:{&quot;value&quot;:&quot;0&quot;}},&quot;macroMetadata&quot;:{&quot;schemaVersion&quot;:{&quot;value&quot;:&quot;2&quot;},&quot;title&quot;:&quot;Untergeordnete Seiten&quot;}}"></div>
```

- The child-pages macro **auto-lists** the persona/journey pages filed beneath the container - never hand-list them.
- Keep the `<div data-*>` and the whole `data-parameters` string **verbatim** (technical macro config, incl. `title: "Untergeordnete Seiten"`). Only the intro `<p>` is written in the output language.

---

## Persona page (HTML+, `contentFormat: html`)

Page title: `{prefix}{Name}, {age} - {short characterization}`

```html
<div data-type="bodied-extension" data-extension-key="excerpt" data-extension-type="com.atlassian.confluence.macro.core" data-parameters='{"macroParams":{"name":{"value":"summary"}}}'><p>{Short prose: context, situation, why the problem hits exactly them.}</p></div>
<div data-type="bodied-extension" data-extension-key="details" data-extension-type="com.atlassian.confluence.macro.core"><table data-width="760"><tbody><tr><th><p><strong>{Involved in these journey(s)}</strong></p></th><td><p><a href="{journey-url}" data-card-appearance="inline">{journey-url}</a></p></td></tr><tr><th><p><strong>Product brief</strong></p></th><td><p><a href="{brief-url}" data-card-appearance="inline">{brief-url}</a></p></td></tr></tbody></table></div>
<h2>{Expectations}</h2>
<section data-type="layout-two-equal" data-breakout="wide" data-breakout-width="760"><div data-type="column" data-width="50"><h3>{Emoji} {Expectation 1 - title}</h3><p>{one or two sentences}</p></div><div data-type="column" data-width="50"><h3>{Emoji} {Expectation 2 - title}</h3><p>{…}</p></div></section>
<section data-type="layout-two-equal" data-breakout="wide" data-breakout-width="760"><div data-type="column" data-width="50"><h3>{Emoji} {Expectation 3 - title}</h3><p>{…}</p></div><div data-type="column" data-width="50"><h3>{Emoji} {Expectation 4 - title}</h3><p>{…}</p></div></section>
```

- The excerpt is **plain text, named `summary`** (no panel - it is
  transcluded by the journey; a panel would travel with it).
- Choose the **emoji** per expectation to fit the app's topic, not fixed.
- One h3 per expectation keeps it individually addressable - in a review
  comment and as a link target. A real example: `example-persona.md`.
- On an odd count leave the last column empty (`<p></p>`).

---

## Journey page (HTML+, `contentFormat: html`)

Page title: `{prefix}{id}: {the action}`

`{id}` is `J-001`, `J-002`, … under the standard scheme, or the id from an
existing numbering, verbatim, with `/1`, `/2` for a split journey
(`discovery-rules.md`, "Journey ids"). The title names the **action** ("Ein
Handout löschen"), never the story ("Der Abend, an dem es steht"). The id stays
verbatim; the action follows the output language. A real example:
`references/example-journey.md`.

```html
<div data-type="bodied-extension" data-extension-key="excerpt" data-extension-type="com.atlassian.confluence.macro.core" data-parameters='{"macroParams":{"name":{"value":"summary"}}}'><p>{Short summary of the journey, one sentence.}</p></div>
<div data-type="bodied-extension" data-extension-key="details" data-extension-type="com.atlassian.confluence.macro.core"><table data-width="760"><tbody><tr><th><p><strong>{Status}</strong></p></th><td><p><span data-type="status" data-color="blue">{Draft}</span></p></td></tr><tr><th><p><strong>Epic in Jira</strong></p></th><td><p>{to follow}</p></td></tr><tr><th><p><strong>{Addressed core capabilities}</strong></p></th><td><ul><li><p><a href="{brief-url}#{anchor of capability A}">{Capability A}</a></p></li><li><p><a href="{brief-url}#{anchor of capability B}">{Capability B}</a></p></li></ul></td></tr></tbody></table></div>
<h2>Persona(s)</h2>
<div data-type="extension" data-extension-key="excerpt-include" data-extension-type="com.atlassian.confluence.macro.core" data-parameters='{"macroParams":{"":{"value":"{the persona page title, exactly as that page is titled}"}}}'></div>
<h2>{Trigger}</h2>
<p>{the concrete moment that starts the journey}</p>
<h2>Journey</h2>
<p>{Movement 1: the starting situation - who they are, what undertaking, for whom, and what the thing is.}</p>
<p>{Movement 2: why the product enters, said out loud.}</p>
<p>{Movement 3: the actions in order, each one named. One or more paragraphs.}</p>
<p>{Movement 4: the outcome - what is different now.}</p>
<h2>{Pain points today}</h2>
<section data-type="layout-two-equal" data-breakout="wide" data-breakout-width="760"><div data-type="column" data-width="50"><h3><span data-type="status" data-color="red">{Problem}</span> {title}</h3><p>{reasoning}</p></div><div data-type="column" data-width="50"><h3><span data-type="status" data-color="red">{Problem}</span> {title}</h3><p>{…}</p></div></section>
<h2>{What the app changes}</h2>
<section data-type="layout-two-equal" data-breakout="wide" data-breakout-width="760"><div data-type="column" data-width="50"><h3><span data-type="status" data-color="green">{Solution}</span> {title}</h3><p>{…}</p></div><div data-type="column" data-width="50"><h3><span data-type="status" data-color="green">{Solution}</span> {title}</h3><p>{…}</p></div></section>
<h2>{Risks}</h2>
<section data-type="layout-two-equal" data-breakout="wide" data-breakout-width="760"><div data-type="column" data-width="50"><h3><span data-type="status" data-color="yellow">{Risk}</span> {title}</h3><p>{what makes delivery costly, uncertain or tight on time}</p></div><div data-type="column" data-width="50"><h3><span data-type="status" data-color="yellow">{Risk}</span> {title}</h3><p>{…}</p></div></section>
<h2>{Related work items}</h2>
<p>{to follow}</p>
```

- Excerpt = plain text, named `summary` (no panel).
- **The status row comes first** and starts blue (`{Draft}`). The colour is
  the value other skills read - blue, yellow, green - so the label can follow
  the output language. Yellow and green only on the user's word
  (`discovery-rules.md`, "A journey carries a status").
- **The excerpt-include takes the persona's title verbatim**, in whichever form
  the tree uses. A title in the wrong form finds nothing and the section renders
  empty.
- **Addressed core capabilities are deep links** into the brief's headings, one
  per capability - anchor scheme in `confluence-style.md`. Plain text there
  loses the only bridge back to the brief.
- **The journey text runs in four movements**, one `<p>` each or more, never a
  single paragraph. `example-journey.md` shows it on a real case.
- **Trigger is the moment only** (weekday, time, state of things). The starting
  situation belongs in movement 1; written in both places it stands twice.
- **Pain points** each h3 with a red `{Problem}` chip, **what the app
  changes** each h3 with a green `{Solution}` chip.
- **Risks** each h3 with a yellow `{Risk}` chip: the delivery side, not the
  user's. **Only when a risk is named**; otherwise leave the `{Risks}` heading
  and its layout out entirely, never write an invented risk or an empty
  section. A risk named later adds the section in exactly this place.
- **This skill only writes placeholders for the two epic-dependent spots.**
  There is no epic yet, so the "Epic in Jira" row is `{to follow}` and the
  "Related work items" section is a plain `{to follow}` paragraph. **Do not
  build any Jira card, macro or table here, and never read other pages** -
  there is nothing to look up. Planning fills both in when it creates the
  epic (see the planning skill).
