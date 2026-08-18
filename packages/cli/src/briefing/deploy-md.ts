import type { ResolvedService } from '../create/types.js';
import {
  curatedServiceDeploy,
  curatedServiceDeployRequires,
} from '../create/catalog.js';

/**
 * Generates `.monoceros/deploy.md`: the parts list the in-container
 * agent works from when the project needs a compose file for its
 * pipeline.
 *
 * The workbench knows which services the app depends on; it does not know
 * the project's compose file, which the developer edits too. So it does
 * not write that file: it hands over one ready block per service
 * (`deploy.compose` from the descriptor, tag checked against
 * `service.image`) and the agent assembles the app's own services around
 * them.
 *
 * Returns `null` when no configured service contributes a fragment. The
 * caller then writes no file and the briefing does not reference one; an
 * empty parts list is worse than no parts list.
 */
export function generateDeployMd(
  services: readonly ResolvedService[],
): string | null {
  const known = services
    .map((svc) => ({ svc, compose: curatedServiceDeploy(svc.name) }))
    .filter((e): e is { svc: ResolvedService; compose: string } =>
      Boolean(e.compose),
    );
  if (known.length === 0) return null;

  const without = services.filter((svc) => !curatedServiceDeploy(svc.name));

  const lines: string[] = [];
  lines.push('# Taking these services to a pipeline');
  lines.push('');
  lines.push(
    'Auto-generated from the services in this container. Each block is that',
    "service's shape for a compose file the pipeline can bring up and run",
    'tests against, which is not the shape it has in here. Not a production',
    'manifest.',
  );
  lines.push('');

  lines.push('## How to use this');
  lines.push('');
  lines.push(
    "- Copy a block verbatim under its service key, then add the app's own",
    '  services around it (build, migrations, the app itself).',
    '- The compose file belongs to the repo. On a later run reconcile it:',
    '  add what is missing, leave what a human edited alone.',
    '- Every `${VAR}` is required by design and its value is a pipeline',
    '  secret, so do not hardcode it anywhere else in the pipeline either.',
    '- Services reach each other by name. Publish a port only when',
    '  something outside the compose network has to reach it.',
    '- Comment your own services only where the choice is surprising, one',
    '  line each. Plans and open decisions belong in an issue, not in a',
    '  comment that ages in the repo.',
  );
  lines.push('');

  for (const { svc, compose } of known) {
    lines.push(`## ${svc.name}`);
    lines.push('');
    lines.push('```yaml');
    lines.push(`${svc.name}:`);
    // The block carries the catalog's tag so the descriptor reads as a
    // finished compose service; if this container runs a different image,
    // that one wins here too.
    const body = compose.replace(/^(\s*image:\s*)\S+$/m, `$1${svc.image}`);
    for (const line of body.replace(/\n+$/, '').split('\n')) {
      lines.push(line ? `  ${line}` : '');
    }
    lines.push('```');
    lines.push('');

    // A fragment with top-level keys, not a service body: a named volume
    // only exists when it is declared up there. Everything in it is named
    // after the component, so it merges into the compose file's existing
    // `services:` / `volumes:` without colliding.
    const requires = curatedServiceDeployRequires(svc.name);
    if (requires) {
      lines.push('It needs these of its own:');
      lines.push('');
      lines.push('```yaml');
      for (const line of requires.replace(/\n+$/, '').split('\n')) {
        lines.push(line);
      }
      lines.push('```');
      lines.push('');
    }
  }

  // Every value in these blocks is `${VAR:?message}` by rule (ADR 0037), so a
  // missing one stops `docker compose` instead of starting on a dev credential.
  // That only helps if the names end up somewhere a human can fill them, which
  // is the project's own env sample - and the agent had no way of knowing that
  // from the blocks alone. Listing them here beats asking it to grep.
  const required = requiredVariables(known);
  if (required.length > 0) {
    lines.push('## Variables these blocks require');
    lines.push('');
    lines.push(
      'Every value above is a required variable: compose refuses to start',
      'without it rather than falling back to a dev default. Collect them in the',
      "project's own env sample (`.env.example` or whatever it already uses),",
      'with an empty value and the explanation from the block, and set the real',
      'values as pipeline secrets. Do not invent defaults and do not copy the',
      'dev credentials from `<name>.env`.',
    );
    lines.push('');
    for (const name of required) {
      lines.push(`- \`${name}\``);
    }
    lines.push('');
  }

  // Named, not silently omitted: the agent must not read a missing block
  // as "this service needs nothing in the pipeline".
  if (without.length > 0) {
    lines.push('## Without a block');
    lines.push('');
    lines.push(
      `No block on file for ${formatList(
        without.map((s) => `\`${s.name}\``),
      )}. Read the image's own`,
      'documentation, do not copy the dev configuration from',
      '`.devcontainer/compose.yaml`, and do not guess.',
    );
    lines.push('');
  }

  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

/**
 * Whether the briefing should reference `.monoceros/deploy.md` at all,
 * i.e. whether `generateDeployMd` would produce a file. Used by AGENTS.md
 * (for the `@`-import) and by the OpenCode config (for the instructions
 * list), which both run without having rendered the file themselves.
 */
export function hasDeployBriefing(
  services: readonly ResolvedService[],
): boolean {
  return services.some((svc) => curatedServiceDeploy(svc.name) !== undefined);
}

/**
 * The `${VAR:?…}` names across the rendered blocks, in first-seen order per
 * service. Reads the same strings the file shows, so the list cannot drift from
 * the blocks above it.
 */
function requiredVariables(
  known: readonly { svc: ResolvedService; compose: string }[],
): string[] {
  const out: string[] = [];
  for (const { svc, compose } of known) {
    const requires = curatedServiceDeployRequires(svc.name) ?? '';
    for (const m of `${compose}\n${requires}`.matchAll(
      /\$\{([A-Za-z_][A-Za-z0-9_]*):\?/g,
    )) {
      const name = m[1]!;
      if (!out.includes(name)) out.push(name);
    }
  }
  return out;
}

/** `a`, `a and b`, `a, b and c`. */
function formatList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
