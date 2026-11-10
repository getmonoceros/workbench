# Template: Design Brief (HTML+)

In Confluence as **HTML+** (`contentFormat: html`). A marker per section type -
see `references/confluence-style.md`. Describe the **direction**, not finished
tokens. Remove the `{...}` hints.

Page title: `{prefix}Design Brief`, where `{prefix}` is `{Product name} | ` or
nothing - the per-tree decision in `references/discovery-rules.md`. The artifact
words stay **English** so titles are language-neutral; the page content follows
the output language.

## Output language - what to translate and what not

Render **all reader-visible text in the output language** (the user's language):
section headings (`<h2>`/`<h3>` text), status-chip labels, color words, the
italic disclaimer, and prose. The English strings below are the **reference
meaning**, not literal output.

**Never translate** (leave verbatim): every `data-*` attribute, `data-extension-key`
and extension type, macro parameter names, the excerpt name `Summary`,
`data-color` values, the page-title artifact word (`Design Brief`), and any
macro/excerpt name. Emojis are structural markers - keep them.

## Guiding idea: rhythm, not a grid

The design brief has a **fixed section skeleton**, but **no uniform layout**.
That is exactly the point: if every section looked the same (2 columns
everywhere, emoji everywhere), the page would become unreadable. So **each
section gets a different treatment, and never the same one twice in direct
succession**. The treatment fits the content. Concretely, the approved layout:

| Section | Treatment |
|---|---|
| Design goal (north star) | named excerpt `Summary`, plain text |
| Brand personality & tone | full width, h3 + p, **mood emoji** per trait |
| Design principles | 2 columns (760), **topic emoji** per principle |
| Visual direction | full width, h3 + p; **palette with color chips** as a mini preview; italic disclaimer at the end |
| Key screens | full width, h3 + p, **numbered squares in teal** |
| Interaction & platform | 2 columns (760), **topic emoji** per point |
| Accessibility | full width, h3 + p, **blue `Required` chip** per requirement |
| Brand & assets | 2 columns (760), plain (no emoji) |
| What the generation should deliver | **success panel** |

Choose emojis to fit the app (not fixed). 2 columns uniformly `760`; on an odd
count leave the last column empty (`<p></p>`).

## HTML patterns per type

**Excerpt (north star):**

```html
<h2>{Design goal (north star)}</h2>
<div data-type="bodied-extension" data-extension-key="excerpt" data-extension-type="com.atlassian.confluence.macro.core" data-parameters='{"macroParams":{"name":{"value":"Summary"}}}'><p>{One sentence: which feeling or outcome the design must achieve.}</p></div>
```

**Full width with emoji** (brand personality, key screens numbered):

```html
<h2>{Brand personality and tone}</h2>
<h3>{Emoji} {Trait 1}</h3>
<p>{how the app feels/sounds and why}</p>
<h3>{Emoji} {Trait 2}</h3>
<p>{…}</p>
```

**2 columns with emoji** (design principles, interaction) - one `<section>` per
pair:

```html
<h2>{Design principles}</h2>
<section data-type="layout-two-equal" data-breakout="wide" data-breakout-width="760"><div data-type="column" data-width="50"><h3>{Emoji} {Principle 1}</h3><p>{from which persona need}</p></div><div data-type="column" data-width="50"><h3>{Emoji} {Principle 2}</h3><p>{…}</p></div></section>
```

**Visual direction** - full width; the palette gets a color-chip row as a mini
preview (chip colors roughly matching the described palette), the italic
disclaimer at the end:

```html
<h2>{Visual direction}</h2>
<h3>{Palette}</h3>
<p><span data-type="status" data-color="green">{Color word 1}</span> <span data-type="status" data-color="yellow">{Color word 2}</span> <span data-type="status" data-color="grey">{Color word 3}</span></p>
<p>{palette described as a mood}</p>
<h3>{Imagery}</h3><p>{…}</p>
<h3>{Typography}</h3><p>{…}</p>
<h3>{Form}</h3><p>{…}</p>
<p><em>{Direction, not final tokens. They emerge during generation.}</em></p>
```

**Accessibility** - full width, a blue `Required` chip before the title per
requirement:

```html
<h2>{Accessibility}</h2>
<h3><span data-type="status" data-color="blue">{Required}</span> {Requirement 1}</h3><p>{…}</p>
<h3><span data-type="status" data-color="blue">{Required}</span> {Requirement 2}</h3><p>{…}</p>
```

**Success panel (what the generation should deliver)** - the handoff into the
build, `<strong>`-led paragraphs:

```html
<h2>{What the generation should deliver}</h2>
<div data-type="panel-success"><p><strong>{Design system as tokens}</strong>: {color, typography, spacing, radii, states, plus a component set}.</p><p><strong>{Hi-fi prototype of the key screens}</strong>: {the screens from the section above}.</p><p><strong>{As code}</strong>: {tokens plus an HTML or React prototype, so the workbench can work on it directly, not Figma-only}.</p></div>
```

Rules:

- **North star** = named excerpt `Summary`, plain text, **no panel** (can be
  transcluded).
- **Keep the rhythm**: no section looks like its direct neighbor. When content
  and volume suggest it, a section may be treated differently than in the table -
  as long as the page stays varied and readable.
- **Handoff** = **success panel**.
- 2 columns uniformly `760`; on an odd count leave the last column empty.
