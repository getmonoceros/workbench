import { existsSync, promises as fsp } from 'node:fs';
import path from 'node:path';
import { consola } from 'consola';
import { matchMonocerosFeature } from '../util/ref.js';
import type { CreateOptions } from './types.js';

/**
 * Hosted providers that authenticate with a single API key, written
 * straight to `provider.<id>.options.apiKey`. This is a heuristic
 * allowlist, not an exhaustive registry: it gates the "just an apiKey"
 * shortcut so a typo'd or local provider name (e.g. `ollama`) doesn't
 * silently produce a half-baked provider block. Anything not here needs
 * the explicit custom-provider path (`npm` + `baseUrl`).
 */
const KNOWN_APIKEY_PROVIDERS = [
  'anthropic',
  'openai',
  'google',
  'openrouter',
  'mistral',
  'groq',
  'deepseek',
  'xai',
] as const;

/**
 * Derive the OpenCode provider id from a `provider/model-id` model
 * string — the segment before the first `/`. Returns `undefined` when
 * the model is empty or has no provider prefix (e.g. a bare model id).
 *
 *   anthropic/claude-sonnet-4-6 → anthropic
 *   openai/gpt-4o-mini          → openai
 *   ''                          → undefined
 *   claude-sonnet-4-6           → undefined
 */
export function deriveOpencodeProvider(model: string): string | undefined {
  return parseOpencodeModel(model)?.provider;
}

/**
 * Split a `provider/model-id` string into its parts. The provider is
 * everything before the first `/`; the model id is everything after
 * (it may itself contain slashes, e.g. `lmstudio/google/gemma-3n`).
 * Returns `undefined` when there is no provider prefix.
 */
export function parseOpencodeModel(
  model: string,
): { provider: string; modelId: string } | undefined {
  const idx = model.indexOf('/');
  if (idx <= 0 || idx === model.length - 1) return undefined;
  return { provider: model.slice(0, idx), modelId: model.slice(idx + 1) };
}

/**
 * Write OpenCode's global config into the container's
 * `home/.config/opencode/opencode.json`, derived from the opencode
 * feature's yml options. No-op when the container has no opencode
 * feature.
 *
 * Written at **apply** (here in the scaffold), NOT baked into the
 * feature's cached image layer — so a change to the yml takes effect on
 * the next apply instead of being frozen by the layer cache (same
 * rationale as `writeClaudePermissionMode`, ADR 0018). The write
 * **merges**: keys the user (or OpenCode) put in opencode.json are
 * preserved; only the keys Monoceros manages are touched.
 *
 * Two provider modes, switched by whether the `npm` option is set:
 *
 *   - **Hosted (`npm` empty)** — the common case. `model:
 *     anthropic/claude-sonnet-4-6` + `apiToken` →
 *     `provider.anthropic.options.apiKey`. The provider must be a known
 *     single-key provider (see `KNOWN_APIKEY_PROVIDERS`); an unknown one
 *     warns instead of writing a broken block. No token = interactive /
 *     env auth, nothing written.
 *   - **Custom (`npm` set)** — local or self-hosted, e.g. Ollama.
 *     `model: ollama/llama3` + `npm: @ai-sdk/openai-compatible` +
 *     `baseUrl: http://ollama:11434/v1` → a full provider block,
 *     including the single-entry `models` map synthesized from the model
 *     id. `apiToken` (if set) becomes `options.apiKey` (some proxies
 *     need it; local Ollama does not).
 *
 * `instructions` (AGENTS.md + the `.monoceros/commands.md` reference,
 * absolute workspace paths) is always written so the briefing loads
 * regardless of auth mode. `permission.external_directory` pre-allows the
 * workspace paths the briefing tells the agent to use (`projects/*`, the
 * `<name>.code-workspace` file, `logs/*`) so it isn't prompted for those;
 * `home/`, `data/` and credentials stay gated.
 */
export async function writeOpencodeConfig(
  targetDir: string,
  containerName: string,
  features: CreateOptions['features'],
): Promise<void> {
  if (!features) return;
  const entry = Object.entries(features).find(
    ([ref]) => matchMonocerosFeature(ref)?.name === 'opencode',
  );
  if (!entry) return; // no opencode feature → nothing to configure

  const options = entry[1] ?? {};
  const str = (key: string): string =>
    typeof options[key] === 'string' ? (options[key] as string).trim() : '';
  const model = str('model');
  const apiToken = str('apiToken');
  const npm = str('npm');
  const baseUrl = str('baseUrl');

  const file = path.join(
    targetDir,
    'home',
    '.config',
    'opencode',
    'opencode.json',
  );
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
      // Malformed opencode.json — start clean rather than failing the
      // apply; we only own a few keys.
      config = {};
    }
  }

  if (typeof config.$schema !== 'string') {
    config.$schema = 'https://opencode.ai/config.json';
  }

  // Briefing: ensure both managed instruction files are present, keeping
  // any the user added. Absolute paths against the in-container workspace
  // root so OpenCode loads them regardless of the session's cwd.
  const workspaceRoot = `/workspaces/${containerName}`;
  const managedInstructions = [
    `${workspaceRoot}/AGENTS.md`,
    `${workspaceRoot}/.monoceros/commands.md`,
  ];
  const existingInstructions = Array.isArray(config.instructions)
    ? (config.instructions as unknown[]).filter(
        (i): i is string => typeof i === 'string',
      )
    : [];
  config.instructions = [
    ...managedInstructions,
    ...existingInstructions.filter((i) => !managedInstructions.includes(i)),
  ];

  // Pre-approve the workspace paths the Monoceros briefing tells the agent to
  // use. OpenCode's `external_directory` permission defaults to "ask" and fires
  // when a tool touches a path outside the working directory (the cwd, checked
  // via `Filesystem.contains`), so launched from a project subdir the agent
  // gets prompted on its first access to these. The briefing directs it to:
  // build under `projects/`, register new projects in `<name>.code-workspace`,
  // and write detached-server PIDs/logs under `logs/`. We allow exactly those,
  // nothing more: `home/` (provider key, .claude.json), `data/`,
  // `.devcontainer/` and `.monoceros/git-credentials` stay gated. OpenCode's
  // wildcard turns `*` into the regex `.*`, which spans `/`, so a single star
  // covers every depth (`**` is not a special token there). Skipped when the
  // user set a string-valued `permission` policy, which we leave alone.
  if (typeof config.permission !== 'string') {
    const permission =
      typeof config.permission === 'object' && config.permission !== null
        ? (config.permission as Record<string, unknown>)
        : {};
    const ext =
      typeof permission.external_directory === 'object' &&
      permission.external_directory !== null
        ? (permission.external_directory as Record<string, unknown>)
        : {};
    for (const p of [
      `${workspaceRoot}/projects/*`,
      `${workspaceRoot}/${containerName}.code-workspace`,
      `${workspaceRoot}/logs/*`,
    ]) {
      ext[p] = 'allow';
    }
    permission.external_directory = ext;
    config.permission = permission;
  }

  // Model: only when set. An empty option must not clobber a user-set
  // model, and leaving it unset lets OpenCode prompt on first run.
  if (model) {
    config.model = model;
  }

  const parsed = parseOpencodeModel(model);

  if (npm) {
    // Custom-provider mode: build the full block (npm + baseURL + the
    // single-entry models map synthesized from the model id).
    if (!parsed) {
      consola.warn(
        '[opencode] `npm` is set but `model` is empty or has no provider prefix — set `model: <provider>/<model-id>` to configure a custom provider.',
      );
    } else {
      writeCustomProvider(config, parsed, { npm, baseUrl, apiToken });
    }
  } else if (parsed) {
    // Hosted-provider mode.
    if (
      (KNOWN_APIKEY_PROVIDERS as readonly string[]).includes(parsed.provider)
    ) {
      // A token is optional: without one, the provider authenticates via
      // its standard env var or an interactive `opencode auth login`.
      if (apiToken) {
        writeHostedApiKey(config, parsed.provider, apiToken);
      }
    } else {
      consola.warn(
        `[opencode] '${parsed.provider}' is not a known single-key provider (${KNOWN_APIKEY_PROVIDERS.join(', ')}). For a custom or local provider (e.g. Ollama), set the \`npm\` and \`baseUrl\` options on the opencode feature.`,
      );
    }
  }

  await fsp.writeFile(file, `${JSON.stringify(config, null, 2)}\n`);
}

/** `config.provider` as a mutable object, creating it if absent. */
function providersOf(config: Record<string, unknown>): Record<string, unknown> {
  if (typeof config.provider === 'object' && config.provider !== null) {
    return config.provider as Record<string, unknown>;
  }
  const fresh: Record<string, unknown> = {};
  config.provider = fresh;
  return fresh;
}

/** A provider entry's object, creating it if absent or malformed. */
function providerEntry(
  providers: Record<string, unknown>,
  id: string,
): Record<string, unknown> {
  if (typeof providers[id] === 'object' && providers[id] !== null) {
    return providers[id] as Record<string, unknown>;
  }
  const fresh: Record<string, unknown> = {};
  providers[id] = fresh;
  return fresh;
}

/** A provider entry's `options` object, creating it if absent or malformed. */
function optionsOf(entry: Record<string, unknown>): Record<string, unknown> {
  if (typeof entry.options === 'object' && entry.options !== null) {
    return entry.options as Record<string, unknown>;
  }
  const fresh: Record<string, unknown> = {};
  entry.options = fresh;
  return fresh;
}

function writeHostedApiKey(
  config: Record<string, unknown>,
  provider: string,
  apiToken: string,
): void {
  const entry = providerEntry(providersOf(config), provider);
  optionsOf(entry).apiKey = apiToken;
}

function writeCustomProvider(
  config: Record<string, unknown>,
  parsed: { provider: string; modelId: string },
  {
    npm,
    baseUrl,
    apiToken,
  }: { npm: string; baseUrl: string; apiToken: string },
): void {
  const entry = providerEntry(providersOf(config), parsed.provider);
  entry.npm = npm;
  if (typeof entry.name !== 'string') entry.name = parsed.provider;

  const opts = optionsOf(entry);
  if (baseUrl) opts.baseURL = baseUrl;
  if (apiToken) opts.apiKey = apiToken;

  // Synthesize the single-entry models map from the model id, keeping any
  // models already present (a user/OpenCode could have added others).
  const models =
    typeof entry.models === 'object' && entry.models !== null
      ? (entry.models as Record<string, unknown>)
      : {};
  if (models[parsed.modelId] === undefined) {
    models[parsed.modelId] = { name: parsed.modelId };
  }
  entry.models = models;
}
