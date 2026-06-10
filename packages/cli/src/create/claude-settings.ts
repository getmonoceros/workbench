import { existsSync, promises as fsp } from 'node:fs';
import path from 'node:path';
import { matchMonocerosFeature } from '../util/ref.js';
import type { CreateOptions } from './types.js';

/**
 * Map the friendly yml `permissionMode` option (on the claude-code feature)
 * to Claude Code's `settings.json` `permissions.defaultMode` value.
 *
 * Default is `auto` → Claude's Auto Mode: no per-action approval prompts and,
 * unlike Bypass, **no recurring "accept responsibility" warning** (a
 * background classifier vets actions). That is the comfortable "it just works"
 * default, well-suited to an isolated container. Alternatives:
 *   - `ask`    → `default`           (prompt as usual)
 *   - `edits`  → `acceptEdits`       (auto file edits, Bash still prompts)
 *   - `bypass` → `bypassPermissions` (no prompts at all; we suppress its
 *                                     one-time warning, see writeClaudePermissionMode)
 * Raw Claude values are accepted as-is too, so the escape hatch is always there.
 */
export function resolveClaudeDefaultMode(raw: string | undefined): string {
  switch ((raw ?? 'auto').trim()) {
    case 'ask':
    case 'default':
      return 'default';
    case 'edits':
    case 'acceptEdits':
      return 'acceptEdits';
    case 'plan':
      return 'plan';
    case 'bypass':
    case 'bypassPermissions':
      return 'bypassPermissions';
    case 'auto':
    case '':
      return 'auto';
    default:
      // Unknown value → the comfortable default rather than an error; a typo
      // should not strand the build.
      return 'auto';
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
 * write **merges**: every other key the user (or Claude) put in settings.json
 * is preserved.
 *
 * Beyond `permissions.defaultMode` it manages two mode-specific keys so the
 * persona never faces a surprise prompt, switching them on/off to match the
 * mode (both are keys Claude itself writes, so this is the same class as our
 * trust pre-approval):
 *   - `auto`   → set `env.CLAUDE_CODE_ENABLE_AUTO_MODE=1` so Auto Mode is
 *                enabled where the account supports it.
 *   - `bypass` → set `skipDangerousModePermissionPrompt=true` so its one-time
 *                "accept responsibility" warning doesn't appear.
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

  // Auto Mode: enable it via env where the account supports it; otherwise drop
  // the flag so a switch away from auto doesn't leave it set. Preserve any
  // other env keys the user added.
  const env =
    typeof config.env === 'object' && config.env !== null
      ? (config.env as Record<string, unknown>)
      : {};
  if (mode === 'auto') {
    env.CLAUDE_CODE_ENABLE_AUTO_MODE = '1';
  } else {
    delete env.CLAUDE_CODE_ENABLE_AUTO_MODE;
  }
  if (Object.keys(env).length > 0) config.env = env;
  else delete config.env;

  // Bypass: pre-accept its one-time warning; otherwise clear the flag.
  if (mode === 'bypassPermissions') {
    config.skipDangerousModePermissionPrompt = true;
  } else {
    delete config.skipDangerousModePermissionPrompt;
  }

  await fsp.writeFile(file, `${JSON.stringify(config, null, 2)}\n`);
}
