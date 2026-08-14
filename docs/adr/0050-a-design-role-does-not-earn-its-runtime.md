# ADR 0050: A design role does not earn its runtime, and the design contract is parked

- Status: rejected, not shipped
- Date: 2026-08-11
- Relates to: [ADR 0043](0043-opencode-roles-as-its-own-component.md) (the two
  role sets as deliberate copies, and one set per workbench),
  [ADR 0019](0019-component-taxonomy-service-feature-dependency.md) (why
  Storybook is a dependency and not a catalog component)

## Outcome first

The role was built, run five times on two agents, and **not shipped**. What
follows is the design that was reached and the measurements that ended it, so the
next attempt starts from the numbers rather than from the idea.

The contract itself held: every rule that was enforced at the write held on every
model, and the artefacts were correct. What did not hold was the proposition. A
design-system run cost 24 to 34 minutes and 84k to 168k output tokens, on Opus
and on Kimi alike, so it was not a model problem. Against that, the tool the
builder already has shows a first artefact in about a minute, and a plain prompt
without any role built a working task app in six minutes of machine time.

Two findings decided it, and neither is fixable by editing a prompt:

- **The output is generic.** The catalogue is a fixed list of components, taken
  from the assignment rather than derived from the app, so every project gets the
  same catalogue with different colours. There is no correctness argument to set
  against the cost: nothing here prevents an expensive mistake.
- **The cost is structural.** 190 to 280 KB of hand-authored HTML per run is
  127k+ output tokens, and that is the runtime. A measured cause was found and
  would have helped (the contract had no shared stylesheet, so every screen
  re-declared two thirds of the catalogue's CSS, 91 of 141 selectors duplicated
  in one measured pair) but fixing it moves a 30-minute run to a shorter one, not
  into the range where a builder reaches for it.

## Context

The role set covered planning, implementing and reviewing and carried no design
knowledge at all, so every UI task started from whatever the model happened to
associate with the words in the prompt. Two sessions on the same project produced
two visual languages, and nothing in the pipeline noticed.

A fourth role fixes that only if its output is worth something to the next step.
That is the whole question this ADR settles: not whether an agent can produce a
design, which it plainly can, but **what it hands over, where that lives, and
which of its rules survive a model that would rather not follow them**.

Two runs decided the second half. On a mid-tier model, with all three rules
written into the prompt as hard rules and one of them illustrated with the
counterexample from the previous run, the role renamed the contract files to
`TOKENS.html` and `COMPONENTS.html`, wrote a `system.css` and a `proto.js`
nobody asked for, left `DESIGN.md` and `index.html` missing, pulled two webfonts
off a CDN while explaining in its report that it had done so, and replaced the
prescribed token check with one of its own that could not fail. It reported
everything as clean with 84 raw values in the two files it had just written.

## Decision

### The contract is a project artefact, unlike the plan

`projects/<app>/design/` holds `DESIGN.md`, `tokens.css`, `components.html`,
`index.html`, and `screens/<name>.html` and `flows/<flow>/<step>.html` as later
assignments add them. It lives in the repo, next to the code it governs.

That is the opposite of where the plan lives, and deliberately so. A plan is
task-scoped and sits outside the project under the persisted agent home, so
wiping `projects/` does not take the plans with it. A design contract is
project-scoped and outlives every task that reads it, so it belongs in the
repository and in its history. The two contracts have different lifetimes, so
they get different places.

### Plain HTML and CSS, rendering offline

No framework, no build step, nothing fetched from the network. The builder opens
the files by double-clicking them through the mounted workspace.

`tokens.css` carries every value the project may use, and everything else
references it with `var(--…)`. That is not a style preference: CSS custom
properties are the machine-readable contract **and** the rendering at once, so
one artefact serves the reviewer's eye and a later check by command. A framework
choice in the catalogue would decide the app's framework by the back door, and a
prototype that needs a toolchain to be looked at will not be looked at.

### Three rules are enforced at the write, not requested in the prompt

The file set, raw values outside `tokens.css`, and anything loaded over the
network are refused when the file is written. On Claude Code that is the existing
`guard.mjs` `PreToolUse` hook, extended with a fourth role. On OpenCode it is a
plugin on `tool.execute.before`, because the agent's `permission` block decides
by path glob and these rules decide on what a file contains.

Refusing at the write is also the cheap moment: the agent gets the reason inside
the run it is already in and rewrites the file, where a round trip through a
fresh subagent afterwards costs far more and arrives after the whole artefact
exists. A later run showed this working, with the role dropping its webfonts and
moving the families to system stacks, noting in `tokens.css` where to swap them
back.

The check in the skill therefore stopped being the safeguard and became the probe
on it. It runs once, and a hit is reported as a leak in the hook rather than
repaired by handing findings back and forth, which costs more than the finding is
worth.

### The craft references are vendored, not fetched

`packages/cli/templates/craft/` holds eleven rulebooks on the parts of this work
that have right answers: type scale and measure, palette structure and accent
caps, contrast floors, which states a component actually has, motion durations,
form validation, bidirectional text, and the defaults that make a design look
generated. An apply copies them into the container beside the guard, and the role
is told to read the ones its assignment touches before it writes.

They come from the `craft/` directory of nexu-io/open-design under Apache-2.0,
recorded in `NOTICE`, with the upstream's own attribution to an MIT-licensed
project left in place. Vendored rather than fetched at install time, so a
workbench builds without reaching for another project and a release is
reproducible. The trade is that a change upstream does not reach us, which is
acceptable for material that is closer to a handbook than to a dependency.

One copy for both role sets, unlike the prompts. The prompts are deliberate
copies because the two agents differ ([ADR 0043](0043-opencode-roles-as-its-own-component.md));
the craft content does not differ at all, so a second copy would only be a second
thing to forget.

Without them the role knows the checklist and not the handbook: it can be told to
show every state and to measure contrast, but not how to build a type scale. That
was the gap between what the role delivered and what it was asked for.

### Standalone first

Nothing reads `design/` automatically. The three existing roles are untouched,
and pointing the implementer at the contract is the builder's move for now.
Routing every UI task through an unproven prompt would put working roles at risk
before anyone had judged a single output, and while `design/` is inert a bad
result costs one look.

## What is parked, and what survives

Parked: the fourth role in both sets, its skill and command, the guard's designer
branch with the three content rules, the OpenCode plugin, the vendored craft
references and the `NOTICE` entry that attributes them. None of it is wired into
the three working roles, so nothing regresses by leaving it.

What survives as knowledge, independent of the role:

- **Enforce at the write, do not ask in the prompt.** Three rules were written
  into the prompt as hard rules, illustrated with counterexamples from real runs,
  and broken anyway by every model but the strongest. The same three rules held
  without exception once a hook refused the write. That lesson generalises to any
  rule a role must not negotiate.
- **OpenCode can enforce like Claude Code can.** `tool.execute.before` in a
  plugin under `~/.config/opencode/plugin/` is the counterpart of a `PreToolUse`
  hook, verified in a container. Its input carries `{ tool, sessionID, callID }`
  and no agent, so such a rule is scoped by path.
- **A prompt-only feedback loop is the wrong loop.** Seven rounds were spent
  finding defects by running the role at 25 to 35 minutes each. The single most
  useful finding came from measuring file sizes and counting CSS selectors, which
  took seconds. Measure the artefact before generating another one.

## Consequences

- The OpenCode plugin is scoped by path, not by role: `tool.execute.before`
  receives `{ tool, sessionID, callID }` and no agent. Nothing but the designer
  writes under `design/`, so the path is enough, and an implementer reaching in
  there would be writing the contract it is meant to build against.
- Wiring the contract into `monoceros-implement` and `monoceros-review` is the
  follow-up, and it is where token discipline becomes an acceptance command that
  can fail.
- Any screenshot or visual parity check needs a headless browser in the
  container, which is its own issue.
- Storybook stays out under
  [ADR 0019](0019-component-taxonomy-service-feature-dependency.md): a
  dependency from the project's own manifest, not a catalog component. The role
  may emit stories where a project already has it.
- **Taste has no acceptance command.** Token discipline is enforceable and is
  enforced; whether a design is any good is decided by a human looking at it.
  The role says so instead of pronouncing on its own output, and the skill stops
  and asks rather than reporting a verdict.
