import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { CommandDef } from 'citty';
import type { CreateOptions } from '../create/types.js';
import type { Component } from '../init/components.js';
import {
  agentsMdInputFromCreateOptions,
  generateAgentsMd,
} from './agents-md.js';
import { generateClaudeMd } from './claude-md.js';
import { generateCommandsMd } from './commands-md.js';
import { replaceMarkerBlock, wrapWithMarkers } from './markers.js';
import {
  loadFeatureManifestSummary,
  type FeatureManifestSummary,
} from '../init/manifest.js';

/**
 * Write the three briefing files into the container workspace:
 *
 *   <targetDir>/AGENTS.md           — Monoceros block in markers + user notes
 *   <targetDir>/CLAUDE.md           — single line `@AGENTS.md` (import stub)
 *   <targetDir>/.monoceros/commands.md  — per-subcommand reference
 *
 * AGENTS.md uses marker-aware writes: if an existing file already has
 * the `<!-- monoceros:begin -->` / `<!-- monoceros:end -->` pair,
 * only the content between markers is replaced and user notes outside
 * survive. If markers are missing, the whole file is rewritten with
 * markers (Monoceros treats files without markers as its own).
 *
 * CLAUDE.md and commands.md are always rewritten in full — they're
 * 100% Monoceros-owned.
 */
export async function writeBriefing(input: WriteBriefingInput): Promise<void> {
  const subCommands = input.subCommands ?? (await loadSubCommandsDynamic());

  const manifestLoader =
    input.manifestLoader ?? ((ref: string) => loadFeatureManifestSummary(ref));
  const agentsBody = generateAgentsMd(
    agentsMdInputFromCreateOptions(
      input.createOpts,
      featureDisplayMap(input.components),
      manifestLoader,
    ),
  );
  const claudeBody = generateClaudeMd();
  const commandsBody = generateCommandsMd(subCommands);

  await writeAgentsMd(path.join(input.targetDir, 'AGENTS.md'), agentsBody);
  await fs.writeFile(
    path.join(input.targetDir, 'CLAUDE.md'),
    claudeBody,
    'utf8',
  );

  const monocerosDir = path.join(input.targetDir, '.monoceros');
  await fs.mkdir(monocerosDir, { recursive: true });
  await fs.writeFile(
    path.join(monocerosDir, 'commands.md'),
    commandsBody,
    'utf8',
  );
}

export interface WriteBriefingInput {
  /** Absolute path to `<MONOCEROS_HOME>/container/<name>/`. */
  targetDir: string;
  createOpts: CreateOptions;
  /** Loaded component catalog — used to map feature refs to display names. */
  components: ReadonlyMap<string, Component>;
  /**
   * Pre-loaded citty subcommand map. Tests pass a minimal map here;
   * runtime callers can leave this `undefined` and the function will
   * dynamically import `../main.js` to break the static import cycle
   * (apply imports briefing, briefing would otherwise need to import
   * the command list which imports apply).
   */
  subCommands?: Record<string, CommandDef | unknown>;
  /**
   * Resolver for feature manifests by ref. Defaults to
   * `loadFeatureManifestSummary` from `init/manifest.ts`, which reads
   * from the workbench checkout or the bundled features directory.
   * Tests pass a stub map to keep the manifest content under test
   * control.
   */
  manifestLoader?: (ref: string) => FeatureManifestSummary | undefined;
}

/**
 * Build a `featureRef → displayName` map from the components catalog.
 * Walks every component with category === 'feature' and indexes by
 * the OCI ref each contributes. Multiple components may map to the
 * same ref (`atlassian.yml` and `atlassian/twg.yml` both reference
 * the `atlassian` feature) — the first one wins, since they share a
 * displayName from the user's perspective.
 */
function featureDisplayMap(
  components: ReadonlyMap<string, Component>,
): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const comp of components.values()) {
    if (comp.file.category !== 'feature') continue;
    for (const contribution of comp.file.contributes.features ?? []) {
      if (!out.has(contribution.ref)) {
        out.set(contribution.ref, comp.file.displayName);
      }
    }
  }
  return out;
}

async function writeAgentsMd(filePath: string, body: string): Promise<void> {
  let existing: string | null = null;
  try {
    existing = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (existing) {
    const updated = replaceMarkerBlock(existing, body);
    if (updated !== null) {
      await fs.writeFile(filePath, updated, 'utf8');
      return;
    }
    // Markers missing — treat as Monoceros-owned, full rewrite.
  }
  await fs.writeFile(filePath, wrapWithMarkers(body), 'utf8');
}

async function loadSubCommandsDynamic(): Promise<Record<string, unknown>> {
  // Dynamic import to avoid a static module cycle: apply/index.ts
  // imports briefing, and main.ts (whose subCommands we want) imports
  // every command, including the apply command which imports
  // apply/index.ts. By the time this function runs — after `apply`
  // has already executed — main.ts is fully evaluated.
  const mod = (await import('../main.js')) as {
    main: { subCommands?: Record<string, unknown> };
  };
  return mod.main.subCommands ?? {};
}
