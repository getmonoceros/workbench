# Template: Technical Brief (HTML+)

In Confluence as **HTML+** (`contentFormat: html`). A marker per section type -
see `references/confluence-style.md`. List items are described half-sentences
with the *why*, not keywords. Catalog ids come from the live source. Remove the
`{...}` hints.

Page title: `{prefix}Technical Brief`, where `{prefix}` is
`{Product name} | ` or nothing - the per-tree decision in
`references/discovery-rules.md`. The artifact words stay **English** so titles are
language-neutral; the page content follows the output language.

No meta preamble ("This document captures …"). The page opens with the
architecture; the functional context (the brief) sits in the page tree, a link
to it is superfluous.

## Output language - what to translate and what not

Render **all reader-visible text in the output language** (the user's
language): section headings (`<h2>`/`<h3>` text), status-chip labels, and prose.
The English strings below are the **reference meaning**, not literal output.

**Never translate** (leave verbatim): every `data-*` attribute,
`data-extension-key` and extension type, macro parameter names (`summary`, the
`details` and `excerpt` macros), `data-color` values, JQL/ids, the monoceros
CLI flags (`--template`, `--with-languages`, `--with-services`,
`--with-features`, `--with-mcp-servers`, `--with-ports`, `--with-repos`,
`--provider`) and command names (`monoceros init`, `monoceros add-repo`,
`monoceros list-components`), the
`language-shell` and `language-yaml` classes, URLs, and the page-title artifact word
(`Technical Brief`). Emojis are structural markers - keep them.

```html
<h2>{Architecture at a glance}</h2>
<div data-type="bodied-extension" data-extension-key="excerpt" data-extension-type="com.atlassian.confluence.macro.core" data-parameters='{"macroParams":{"name":{"value":"summary"}}}'><p>{Two to four sentences of prose: how the parts play together - frontend, backend, which data goes where, which services are involved.}</p></div>
<h2>{Building blocks and interfaces}</h2>
<figure data-type="media-single" data-layout="wide" data-width="100" data-width-type="percentage"><div data-type="media" data-media-type="file" data-id="{fileId of the uploaded PNG, from three parts up}" data-collection="contentId-{page id}" data-alt="{Building blocks of <product>}"></div><figcaption>{Building blocks of <product>}</figcaption></figure>
<details><summary>{Diagram source}</summary><pre><code class="language-json">{the diagram spec, HTML-escaped}</code></pre></details>
<h3>{Emoji} {Part 1, e.g. the backend}</h3>
<p>{its job in one sentence, and who it talks to}</p>
<h3>{Emoji} {Part 2}</h3>
<p>{…}</p>
<h2>{Technology decisions}</h2>
<p><em>{State at discovery time. Decisions taken later while building are recorded as ADRs in the repository, not here.}</em></p>
<section data-type="layout-two-equal" data-breakout="wide" data-breakout-width="760"><div data-type="column" data-width="50"><h3>{Emoji} {Area, e.g. Backend}: {Decision}</h3><p>{rationale, with the rejected alternative in a clause}</p><p><strong>{Must satisfy}:</strong> {one sentence, what the decision is checked against}</p></div><div data-type="column" data-width="50"><h3>{Emoji} {Data storage}: {Decision}</h3><p>{…}</p><p><strong>{Must satisfy}:</strong> {…}</p></div></section>
<h2>{Operating frame}</h2>
<h3><span data-type="emoji" data-shortname=":1_one_square_teal:" data-emoji-id="atlassian-1_one_square_teal" data-emoji-text=":1_one_square_teal:">:1_one_square_teal:</span> {Constraint 1, e.g. load}</h3>
<p>{the constraint in an order of magnitude, and the decision it drove}</p>
<h3><span data-type="emoji" data-shortname=":2_two_square_teal:" data-emoji-id="atlassian-2_two_square_teal" data-emoji-text=":2_two_square_teal:">:2_two_square_teal:</span> {Constraint 2, e.g. data classes}</h3>
<p>{…}</p>
<h2>{Cross-cutting conventions}</h2>
<section data-type="layout-two-equal" data-breakout="wide" data-breakout-width="760"><div data-type="column" data-width="50"><h3>{Emoji} {Convention 1, e.g. authentication}</h3><p>{one line}</p><h3>{Emoji} {Convention 2, e.g. validation}</h3><p>{one line}</p></div><div data-type="column" data-width="50"><h3>{Emoji} {Convention 3, e.g. error shape}</h3><p>{one line}</p><h3>{Emoji} {Convention 4, e.g. identifiers}</h3><p>{one line}</p></div></section>
<h2>{Mapping onto the Monoceros container definition}</h2>
<p><em>{Catalog ids from the live source (CLI {version}), or from the builder's own }</em><code>monoceros list-components --copy</code><em>{ output when they keep their own templates. Confirm the exact ids and versions at build time against }</em><code>monoceros list-components</code><em>{.}</em></p>
<div data-type="bodied-extension" data-extension-key="details" data-extension-type="com.atlassian.confluence.macro.core"><table data-width="760"><tbody><tr><th><p><code>--template</code></p></th><td><p>{discovery-atlassian, or the template the builder chose - and what it already brings, its coding agent named; when that agent was not chosen, say it comes out again}</p></td></tr><tr><th><p><code>--with-languages</code></p></th><td><p>{id, id, … - each briefly for what; only what the template does not bring}</p></td></tr><tr><th><p><code>--with-services</code></p></th><td><p>{id, id, … - each briefly for what, the team's own marked as such, a personal one as on the builder's machine only, one nobody has yet as not yet a file (see open points); only what the template does not bring}</p></td></tr><tr><th><p><code>--with-features</code></p></th><td><p>{id, id, … - each briefly for what: the chosen coding agents the template does not carry, the code host, the rest; a default the template lacked says so}</p></td></tr><tr><th><p><code>--with-mcp-servers</code></p></th><td><p>{id, … - only when the build needs one, the team's own marked as such, a personal one as on the builder's machine only, one nobody has yet as not yet a file (see open points); otherwise omit the line}</p></td></tr><tr><th><p><code>--with-ports</code></p></th><td><p>{port numbers the app listens on, each briefly for what - numbers only, never a service name; a service's web UI is not a port here; only ports the template's ports list does not carry}</p></td></tr><tr><th><p><code>--with-repos</code></p></th><td><p>{full HTTPS URL, only for github.com/gitlab.com/bitbucket.org; no repo, another host, or a repo the template's repos list already carries: omit the line}</p></td></tr></tbody></table></div>
<p>{Only when the proposal uses a team file and the output names a templateRepository: }<em>{The team's templates come from }</em><code>{templateRepository}</code><em>{; to get them onto your machine, see }</em><a href="https://getmonoceros.build/docs/guides/templates/#get-it-onto-every-machine">{Get it onto every machine}</a><em>{.}</em></p>
<p>{Not in the yml (app-owned dependencies): {frameworks/libraries the app brings itself}. Tests: {test stacks per component}.}</p>
<p><strong>{A new workbench}</strong>{: as a sketch (the }<code>--with-repos</code>{ line only when a repo exists on github.com/gitlab.com/bitbucket.org and the template does not carry it; otherwise omit):}</p>
<pre data-breakout="wide" data-breakout-width="760"><code class="language-shell">monoceros init {name} --template={discovery-atlassian, or the chosen template} \
  --with-languages={…} \
  --with-services={…} \
  --with-features={…} \
  --with-mcp-servers={…} \
  --with-ports={port numbers, e.g. 3000} \
  --with-repos={full HTTPS URL of the repo, asked from the user - no placeholder}
{only when claude is not among the chosen coding agents:}monoceros remove-feature {name} claude</code></pre>
<p>{Only for a template other than discovery-atlassian: which of the coding agent, }<code>discovery-atlassian</code>{, }<code>agent-roles</code>{, }<code>atlassian</code>{ with twg and the MCP server }<code>monoceros-docs</code>{ it lacked, and that }<code>--with-features</code>{ and }<code>--with-mcp-servers</code>{ above close them.}</p>
<p><strong>{A workbench that already exists}</strong>{: not }<code>init</code>{, but one command per mapped component, then one }<code>monoceros apply {name}</code>{. The template applies only to }<code>init</code>{, so this block names every feature itself, the defaults included. Both blocks always go on the page, because the reader may be in either situation.}</p>
<pre data-breakout="wide" data-breakout-width="760"><code class="language-shell">monoceros add-language {name} {id}
monoceros add-service {name} {id}
monoceros add-feature {name} {one line per chosen coding agent: claude, opencode, copilot}
monoceros add-feature {name} discovery-atlassian
monoceros add-feature {name} agent-roles
monoceros add-feature {name} atlassian/twg
monoceros add-feature {name} {code-host feature, from the answer - or omitted while that is open}
monoceros add-mcp-server {name} monoceros-docs
monoceros add-mcp-server {name} {id, only when the build needs one}
monoceros add-port {name} {port number, one line per port}
monoceros add-repo {name} {https-url, also when the template carries it; --provider=github|gitlab|bitbucket only for another host; no repo yet: omit the line}
monoceros apply {name}</code></pre>
<p>{Repo on another host (self-hosted GitLab, GitHub Enterprise …) not in }<code>--with-repos</code>{, but after the init:}</p>
<pre data-breakout="wide" data-breakout-width="760"><code class="language-shell">monoceros add-repo {name} {https-url} --provider=github|gitlab|bitbucket</code></pre>
<p>{Unless the sketch adds nothing to its template: }<em>{Once the workbench has proven itself on the project, }</em><code>monoceros create-template {name} &lt;new-template&gt;</code><em>{ turns it into a workbench template the next project starts from: }</em><a href="https://getmonoceros.build/docs/reference/utilities/create-template/">{monoceros create-template}</a><em>{.}</em></p>
<p>{Token/PAT setup for cloning and pushing (private repo): }<a href="https://getmonoceros.build/docs/concepts/git-and-repos/">getmonoceros.build/docs/concepts/git-and-repos</a>.</p>
<h2>{Deployment}</h2>
<div data-type="panel-note"><p>{Target and mechanics, as far as known. As long as open: "Target still to be decided" - then NOT additionally in Open points.}</p></div>
<h2>{Open points}</h2>
<section data-type="layout-two-equal" data-breakout="wide" data-breakout-width="760"><div data-type="column" data-width="50"><h3><span data-type="status" data-color="yellow">{open}</span> {Point 1}</h3><p>{what needs clarifying/doing}</p></div><div data-type="column" data-width="50"><h3><span data-type="status" data-color="yellow">{open}</span> {Point 2}</h3><p>{…}</p></div></section>
<!-- A service or MCP server nobody has yet fills a column like any other point, e.g.: -->
<section data-type="layout-two-equal" data-breakout="wide" data-breakout-width="760"><div data-type="column" data-width="50"><h3><span data-type="status" data-color="yellow">{open}</span> {Describe {component} as a file}</h3><p>{What it is for. Described once as }<code>{services|mcp-servers}/{component}.yml</code>{ in the team repository (or in }<code>~/.monoceros/templates/</code>{ without one): }<a href="https://getmonoceros.build/docs/guides/templates/#add-a-service-the-catalog-doesnt-have">{Add a service the catalog doesn't have}</a>{ or }<a href="https://getmonoceros.build/docs/guides/templates/#add-your-own-mcp-server">{Add your own MCP server}</a>{; with a team repository also }<a href="https://getmonoceros.build/docs/guides/templates/#create-a-template-with-an-agent">{Create a template with an agent}</a>{. Then }<code>monoceros add-service {name} {component}</code>{ (or }<code>add-mcp-server</code>{) and }<code>monoceros apply {name}</code>{.}</p></div><div data-type="column" data-width="50"></div></section>
```

Rules:

- **Architecture at a glance** = the **named excerpt `summary`** (plain text, no
  panel). The architecture is the substance of the page and the transcludable
  summary at once - not a duplicate. **No meta intro** as an excerpt.
- **Building blocks and interfaces** = full width, one `<h3>` per part with a
  topic emoji, one sentence on its job and its counterparts. **From three parts
  up, a component diagram sits above them** (recipe in `confluence-style.md`):
  picture first, then the detail. It is an embedded PNG with the spec in a
  collapsed section below it, so the next run renders from the spec. The list
  stays authoritative, the diagram is the overview, and the page has to stand
  without it.
- **Technology decisions** = 2 columns (760), each `<h3>` with a **fitting topic
  emoji** (app-dependent, not fixed: e.g. ☕ Backend, ⚛️ Frontend, 🐍 mock
  service, 🔐 Auth, 🧬 vector DB, 🗄️ object storage, 🔗 integration) + `<p>`
  rationale **including the rejected alternative** in a clause, then a second
  paragraph led by a bold `{Must satisfy}:` carrying **one sentence** on what the
  decision is checked against. On an odd count leave the last column empty.
- **One decision, one cell**: heading, rationale, `Must satisfy`. Never two
  decisions in one column, or the two paragraphs can no longer be told apart.
- **The `Must satisfy` sentence is mandatory** and it is **one** sentence, not a
  list: the columns are 760 wide, and a list of three becomes five wrapped lines.
  Only what is checkable and only what belongs to this decision - what holds for
  every part is in the cross-cutting conventions, and what is about an entity, a
  role or a state is in the domain model.
- **The handoff line** sits in italics under the section heading, so the page may
  age without becoming wrong: this is the discovery-time state, later decisions
  are ADRs in the repository.
- **Operating frame** = full width, `<h3>` + `<p>`, **numbered squares in teal**
  before the title. Every entry names a constraint **and the decision it drove**;
  an entry that drove nothing belongs in the open points, not here. No catalogue
  of non-functional requirements.
- **Cross-cutting conventions** = 2 columns (760), one `<h3>` per convention with
  a topic emoji, **one line** each. Three to five, no more: they exist so that
  every story answers these questions the same way. With more than one subject
  area in the domain model, one of them is the **internal structure** (one
  module per area, only the owner writes, no circle, and the check by name).
- **Mapping onto the container definition** = flag→assignment in the
  **page-properties macro** (`details`), followed by the "Not in the yml" prose
  and **both** command blocks: the `monoceros init --template=…` sketch for a
  new workbench, and the `add-*` commands plus one `apply` for a workbench that
  already exists. Both always, labelled - the reader of the page may be in
  either situation. The `init` flags carry only what the template does not
  already bring. With a template other than `discovery-atlassian`, the line
  under the sketch names the defaults it lacked; with `discovery-atlassian`, it
  does not appear. A component nobody has a file for yet stands in the table,
  marked so, and in neither block. The `create-template` line closes the
  section unless the sketch adds nothing to its template; its template name
  stays a placeholder for a new name, never the one the workbench started
  from (the command never overwrites a template). The table must sit inside the
  `details` macro: a bare table otherwise gets lifted unstably into a `<thead>`
  by the editor. (Even inside the macro the first row lands in `<thead>` -
  harmless on a one-time create, because in ADF it stays a header column
  `th`+`td`.)
- **Repos** = the skill asks whether a repo already exists, unless the chosen
  template's `repos` already carries it: then its `url` and `provider` are the
  answer. No repo → no repo line in either block, carry the repo as an open
  point. A repo exists →
  - **Sketch**: github/gitlab/bitbucket → full HTTPS URL in `--with-repos`.
    Another host → not in `--with-repos`, but
    `monoceros add-repo <name> <url> --provider=…` below it (ask for the
    provider). Neither when the template already carries the repo: `init`
    clones it.
  - **Second block**: always `monoceros add-repo <name> <url>`, with
    `--provider=…` for another host, also when the template carries the repo,
    because the template never reaches a workbench that already exists.

  Under the code block, the docs link to the token setup.
- **Deployment** = **note panel** (`panel-note`). As long as undecided: a short
  "open" text - and the point then does **not** additionally appear in the open
  points (a section is the one place for its topic).
- **Open points** = 2 columns, each `<h3>` with a yellow `open` status chip +
  `<p>`. (HTML+ has no task lists - the chips are the substitute.) On an odd
  count leave the last column empty. **Only what is undecided about the
  product** goes here: a technology choice still open, a port to confirm, an
  unresolved external dependency, a repository that does not exist yet, a
  service or MCP server nobody has a file for yet (one point each: what it is
  for, where the file goes, the guide links, then the `add-*` command; never
  the file's content or an image tag).
  **Configuring a feature is never an open point** - no credentials, no token,
  no `.env` entry. That belongs to setting up the workbench, not to the product.
