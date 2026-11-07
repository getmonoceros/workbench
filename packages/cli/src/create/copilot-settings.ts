import { existsSync, promises as fsp } from 'node:fs';
import path from 'node:path';
import { matchMonocerosFeature } from '../util/ref.js';
import type { CreateOptions } from './types.js';

/**
 * Map the yml `permissionMode` option of the copilot feature to Copilot CLI's
 * `defaultPermissionMode` setting. The option speaks the same words as the
 * claude-code feature, so a builder does not learn a second vocabulary:
 *
 *   - `auto`   → `assisted`  (a model reviews requests and approves the ones
 *                             it judges safe; the rest still asks)
 *   - `ask`    → `manual`    (prompts for every write and command)
 *   - `bypass` → `allow-all` (approves everything, like `--yolo`)
 *
 * Copilot's own values pass through, and anything else falls back to the
 * default: a typo should not strand the build.
 */
export function resolveCopilotPermissionMode(raw: string | undefined): string {
  switch ((raw ?? 'auto').trim()) {
    case 'ask':
    case 'manual':
      return 'manual';
    case 'bypass':
    case 'allow-all':
      return 'allow-all';
    default:
      return 'assisted';
  }
}

/**
 * Write the copilot feature's apply-time config into the persisted `~/.copilot`:
 *
 *   - `settings.json` → `defaultPermissionMode`, from the yml option, and
 *                       `storeTokenPlaintext`. The container has no system
 *                       keychain, so the login token can only live in
 *                       `config.json` (0600, owned by the runtime user), the
 *                       same way Claude Code keeps its credentials on Linux.
 *                       Without the setting, every `copilot login` stops to
 *                       ask whether that is acceptable.
 *   - `config.json`   → the workspace in `trustedFolders`, so the first session
 *                       does not open with a folder-trust prompt. Trusting a
 *                       folder covers its subfolders, so the workspace root is
 *                       enough for every project under it.
 *
 * Written at apply rather than baked into the feature layer, so a yml change
 * takes effect on the next apply (ADR 0018). Both writes merge and touch only
 * their own keys. Both files belong to Copilot, which writes them itself, and
 * `config.json` also holds the login, so a file that does not parse is left
 * alone: overwriting it would cost the builder their login. Copilot opens its
 * own `config.json` with a `//` comment header; that header is kept, and only
 * a file that still does not parse without it is skipped.
 *
 * No-op when the container has no copilot feature.
 */
export async function writeCopilotSettings(
  targetDir: string,
  containerName: string,
  features: CreateOptions['features'],
): Promise<void> {
  if (!features) return;
  const entry = Object.entries(features).find(
    ([ref]) => matchMonocerosFeature(ref)?.name === 'copilot',
  );
  if (!entry) return;

  const raw = entry[1]?.permissionMode;
  const mode = resolveCopilotPermissionMode(
    typeof raw === 'string' ? raw : undefined,
  );
  const home = path.join(targetDir, 'home', '.copilot');

  await mergeJson(path.join(home, 'settings.json'), (config) => {
    config.defaultPermissionMode = mode;
    config.storeTokenPlaintext = true;
  });

  const workspace = `/workspaces/${containerName}`;
  await mergeJson(path.join(home, 'config.json'), (config) => {
    const trusted = Array.isArray(config.trustedFolders)
      ? (config.trustedFolders as unknown[]).filter(
          (f): f is string => typeof f === 'string',
        )
      : [];
    if (!trusted.includes(workspace)) trusted.push(workspace);
    config.trustedFolders = trusted;
  });
}

/**
 * Apply `edit` to the JSON object in `file`, creating it when absent or empty.
 * Leading `//` comment lines are kept as they are. A file that does not parse
 * to an object without them is left untouched (see above).
 */
async function mergeJson(
  file: string,
  edit: (config: Record<string, unknown>) => void,
): Promise<void> {
  let config: Record<string, unknown> = {};
  let header = '';
  if (existsSync(file)) {
    const text = await fsp.readFile(file, 'utf8');
    header = text.match(/^(?:[ \t]*\/\/[^\n]*\n)*/)?.[0] ?? '';
    const body = text.slice(header.length);
    if (body.trim()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        return;
      }
      if (typeof parsed !== 'object' || parsed === null) return;
      if (Array.isArray(parsed)) return;
      config = parsed as Record<string, unknown>;
    }
  }
  edit(config);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, `${header}${JSON.stringify(config, null, 2)}\n`);
}
