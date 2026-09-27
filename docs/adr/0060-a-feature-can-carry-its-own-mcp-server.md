# ADR 0060: A feature can carry its own MCP server, and the browser feature is the first

- Status: accepted
- Date: 2026-09-27
- Implements: #89
- Relates to: [ADR 0045](0045-mcp-servers-as-catalog-components.md) (MCP
  servers as catalog components, and the per-agent translation this reuses),
  [ADR 0019](0019-component-taxonomy-service-feature-dependency.md) (why the
  browser is a feature),
  [ADR 0022 §6](0022-ssh-universal-ide-attach-point.md) (the host browser
  bridge, which this does not replace),
  [ADR 0054](0054-apply-delivers-current-tools-upgrade-moves-the-services.md)
  (the refresh hook)

## Context

An agent in a workbench could start the app it built but could not look at
it. Every check that needs a rendered page went back to the builder: does it
render, is the console clean, did the request go out. The host browser bridge
(ADR 0022 §6) opens a URL in the builder's browser and gives the agent nothing
back.

ADR 0045 anticipated a feature whose MCP server is inseparable from the tool
it installs, and left the mechanism for it open. A browser is that case: the
server is the only way an agent drives the browser, and the browser is useless
to the agent without it.

## Decision

**A feature descriptor may declare `feature.mcpServer:`**, the connector's
canonical shape (ADR 0045) plus the `name` it is registered under. When the
feature is in the yml and an agent is in the container, apply registers the
server with every agent, through the same merge and ownership record as a
`mcpServers:` entry. The builder writes no second line.

- **No agent is not an error.** A `mcpServers:` entry without an agent stops
  the apply, because the entry has no other purpose. A feature has one: the
  browser still runs the project's own Playwright tests. So its server is
  simply not registered.
- **A yml entry under the same name stops the apply**, for the reason ADR
  0045 gives for a hand-added one: no precedence rule is defensible.
- **No `${option}` templates.** Nothing needs one yet, and a feature's options
  are not resolved the way a connector's are. A token would reach the agent's
  config literally, so the descriptor schema rejects it.

**The `browser` feature** is the first carrier:

- **Chromium from Debian, not Playwright's download.** The MCP server floats to
  latest (features are never pinned), and each Playwright release wants its
  own browser revision. A revision downloaded at build time stops matching the
  day the server updates. The Debian package is a fixed path the server is
  pointed at, and it pulls in every shared library a browser needs. Checked on
  arm64, the architecture Playwright's support matrix leaves out for Debian.
  The package registers itself as the system web browser; install.sh takes
  that back out, because opening a browser in this container means the
  builder's own, through the bridge.
- **Playwright MCP, not Chrome DevTools MCP.** Chosen after running both
  against the same page on arm64. The deciding reason in the issue, console
  and network output, no longer tells them apart: Playwright MCP has both.
  What does: DevTools MCP sends usage statistics to Google by default and the
  URLs of performance traces to the CrUX API, which a local-first workbench
  would have to switch off flag by flag. And Playwright MCP reports the
  Playwright code behind every action, which is what the agent needs when the
  goal is the project's own Playwright tests.
- **`--no-sandbox`.** Chromium's sandbox needs privileges the workspace
  container does not grant (confirmed: "No usable sandbox" without the flag).
  Adding `SYS_ADMIN` to get it back would widen the container, which is the
  isolation boundary, to re-enable a second boundary inside it. That trade
  gives up more than it buys.
- **`--output-dir /tmp/playwright-mcp`.** The server otherwise writes
  snapshots and screenshots to `.playwright-mcp/` in the agent's working
  directory, which is the builder's repository.
- **The project's own tests get a persisted cache, not the system Chromium.**
  `@playwright/test` reads no environment variable for a browser path; only
  the project's own config could point it elsewhere, which would make that
  config specific to this container. So the project runs
  `npx playwright install --only-shell chromium` as it would anywhere, without
  `--with-deps` because the libraries are there, and `~/.cache/ms-playwright`
  is a persistent home path so the download survives apply.
- **The MCP server gets a refresh hook (ADR 0054); Chromium does not.** A
  refresh of Chromium means `apt-get update` on every apply. It moves with the
  feature layer, like any apt package.

## Consequences

- Opting in costs a few hundred megabytes of Chromium and its libraries,
  installed at build time. That is why this is a feature and not part of the
  runtime image.
- Headless only. No X server, no VNC. To look at the app the builder uses
  their own browser, through the bridge.
- `monoceros check` reads the registration from the agents' configs and lists
  the server like any other `stdio` one: config verified, not started.
- A second carrier needing a credential would need option templates here, and
  with them the same empty-value rule connectors have.
