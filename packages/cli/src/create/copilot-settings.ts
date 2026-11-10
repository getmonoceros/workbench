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
 *                       With the graphify feature also `hooks`, see
 *                       `applyGraphifyHooks` below, and always a paragraph in
 *                       `assistedApprovalInstructions`, see
 *                       `applyJudgeInstructions`.
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
  const hasGraphify = Object.keys(features).some(
    (ref) => matchMonocerosFeature(ref)?.name === 'graphify',
  );
  const home = path.join(targetDir, 'home', '.copilot');

  await mergeJson(path.join(home, 'settings.json'), (config) => {
    config.defaultPermissionMode = mode;
    config.storeTokenPlaintext = true;
    applyGraphifyHooks(config, hasGraphify);
    applyJudgeInstructions(config);
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

/** Every paragraph Monoceros owns in the judge's instructions starts with this. */
const JUDGE_MARKER = 'Monoceros workbench:';

/** What the judge is told about the workbench's own tooling. */
const JUDGE_INSTRUCTIONS =
  `${JUDGE_MARKER} this session runs in a local dev container. ` +
  "`monoceros-ctl` is the workbench's own tool for the dev servers an app " +
  'declares in `.monoceros/launch.json` (list, start, stop, restart, logs). ' +
  'Running it is routine work on the app, not a risk: approve it. ' +
  '`git add` and `git commit` only change the local history of a repository ' +
  'in this workspace and are just as routine: approve them. Pushing is ' +
  'different, because it leaves the machine.';

/**
 * Tell Copilot's Assisted Permissions judge what `monoceros-ctl` is, and that
 * a local commit is no risk. With `permissionMode: auto` (Copilot's
 * `assisted`) a model reviews every command and asks the user when it is
 * unsure. Real runs had it ask before every `monoceros-ctl stop/start` (a tool
 * it had never seen, restarting servers), and hold the agent-roles developer
 * four minutes on its `git add … && git commit`, which the role is allowed to
 * do. A push stays the user's call, here and in the agent-roles guard.
 *
 * Copilot keeps no persistent allow list for commands: `--allow-tool` is a
 * launch flag, and "allow for this location" is per-directory internal state.
 * `assistedApprovalInstructions` is the documented setting for exactly this
 * judge. It steers it rather than binding it, which is the nature of the mode.
 *
 * Only our paragraph is ours: it is recognised by its marker and replaced, and
 * whatever the builder wrote around it stays.
 */
function applyJudgeInstructions(config: Record<string, unknown>): void {
  const current =
    typeof config.assistedApprovalInstructions === 'string'
      ? config.assistedApprovalInstructions
      : '';
  const foreign = current
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p && !p.startsWith(JUDGE_MARKER));
  config.assistedApprovalInstructions = [...foreign, JUDGE_INSTRUCTIONS].join(
    '\n\n',
  );
}

/** A Copilot CLI hook entry, as it sits under `hooks.<event>` in settings.json. */
interface HookEntry {
  type?: string;
  matcher?: string;
  command?: string;
}

/** Every hook command Monoceros owns here is recognised by this marker. */
const GRAPHIFY_HOOK_MARKER = 'graphify hook-guard';

/**
 * Add or remove graphify's `PreToolUse` hooks in the user-level Copilot
 * settings: the same two hooks the claude-code feature gets
 * (create/claude-settings.ts), for the same reason. The briefing alone does
 * not make an agent ask the graph; a reminder when it reaches for a raw read
 * or a grep does more.
 *
 * `graphify hook-guard` works unchanged here. Under the PascalCase event name
 * `PreToolUse`, Copilot sends Claude Code's payload with Claude Code's tool
 * names (`Read`, `Bash`, `Grep`, `Glob`), uses Claude Code's matcher semantics,
 * and passes `hookSpecificOutput.additionalContext` on to the model. Only the
 * entry shape is Copilot's own: flat, with `matcher` and `command` side by side.
 * Copilot delivers that context after the tool result, not before the call
 * (Copilot CLI 1.0.107), so the reminder steers the agent's next step rather
 * than the read that triggered it.
 *
 * Foreign entries are kept, ours are replaced rather than duplicated on
 * re-apply, and removing the graphify feature removes them again.
 */
function applyGraphifyHooks(
  config: Record<string, unknown>,
  hasGraphify: boolean,
): void {
  const hooks =
    typeof config.hooks === 'object' &&
    config.hooks !== null &&
    !Array.isArray(config.hooks)
      ? (config.hooks as Record<string, unknown>)
      : {};
  const existing = Array.isArray(hooks.PreToolUse)
    ? (hooks.PreToolUse as HookEntry[])
    : [];
  const foreign = existing.filter(
    (entry) => !entry?.command?.includes(GRAPHIFY_HOOK_MARKER),
  );
  const ours: HookEntry[] = [
    {
      type: 'command',
      matcher: 'Bash|Grep',
      command: 'graphify hook-guard search',
    },
    {
      type: 'command',
      matcher: 'Read|Glob',
      command: 'graphify hook-guard read',
    },
  ];
  const next = hasGraphify ? [...foreign, ...ours] : foreign;

  if (next.length > 0) hooks.PreToolUse = next;
  else delete hooks.PreToolUse;

  if (Object.keys(hooks).length > 0) config.hooks = hooks;
  else delete config.hooks;
}

/**
 * Apply `edit` to the JSON object in `file`, creating it when absent or empty.
 * Leading `//` comment lines are kept as they are. A file that does not parse
 * to an object without them is left untouched (see above).
 */
export async function mergeJson(
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
