import { existsSync, promises as fsp } from 'node:fs';
import path from 'node:path';
import { matchMonocerosFeature } from '../util/ref.js';
import type { CreateOptions } from './types.js';

/**
 * Map the friendly yml `permissionMode` option (on the claude-code feature)
 * to Claude Code's `settings.json` `permissions.defaultMode` value.
 *
 * Default is `bypass` → `bypassPermissions`: Claude runs without a prompt on
 * every action. That is the comfortable "it just works" mode and it is
 * defensible *because* Monoceros isolates everything in the container — the
 * container is the safety boundary, not each individual approval. `ask` maps
 * to Claude's `default` (prompt as usual) for anyone who wants that. The raw
 * Claude values are accepted as-is too, so the escape hatch is always there.
 */
export function resolveClaudeDefaultMode(raw: string | undefined): string {
  switch ((raw ?? 'bypass').trim()) {
    case 'ask':
    case 'default':
      return 'default';
    case 'acceptEdits':
      return 'acceptEdits';
    case 'plan':
      return 'plan';
    case 'bypass':
    case 'bypassPermissions':
    case '':
      return 'bypassPermissions';
    default:
      // Unknown value → the safe-in-a-container default rather than an error;
      // a typo should not strand the build.
      return 'bypassPermissions';
  }
}

/**
 * Write Claude Code's default permission mode into the container's
 * `home/.claude/settings.json`, derived from the claude-code feature's
 * `permissionMode` option in the yml. No-op when the container has no
 * claude-code feature.
 *
 * This is written at **apply** (here in the scaffold), NOT baked into the
 * feature's cached image layer — so a change to the yml takes effect on the
 * next apply instead of being frozen by the layer cache (see ADR 0018). The
 * write **merges**: only `permissions.defaultMode` is set, every other key the
 * user (or Claude) put in settings.json is preserved.
 */
export async function writeClaudePermissionMode(
  targetDir: string,
  features: CreateOptions['features'],
): Promise<void> {
  if (!features) return;
  const entry = Object.entries(features).find(
    ([ref]) => matchMonocerosFeature(ref)?.name === 'claude-code',
  );
  if (!entry) return; // no claude-code feature → nothing to configure

  const raw = entry[1]?.permissionMode;
  const mode = resolveClaudeDefaultMode(
    typeof raw === 'string' ? raw : undefined,
  );

  const file = path.join(targetDir, 'home', '.claude', 'settings.json');
  await fsp.mkdir(path.dirname(file), { recursive: true });

  let config: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      const txt = await fsp.readFile(file, 'utf8');
      if (txt.trim()) {
        const parsed: unknown = JSON.parse(txt);
        if (typeof parsed === 'object' && parsed !== null) {
          config = parsed as Record<string, unknown>;
        }
      }
    } catch {
      // Malformed settings.json — start from a clean object rather than
      // failing the apply; we only own the one key.
      config = {};
    }
  }

  const permissions =
    typeof config.permissions === 'object' && config.permissions !== null
      ? (config.permissions as Record<string, unknown>)
      : {};
  permissions.defaultMode = mode;
  config.permissions = permissions;

  await fsp.writeFile(file, `${JSON.stringify(config, null, 2)}\n`);
}
