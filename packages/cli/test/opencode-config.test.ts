import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deriveOpencodeProvider,
  parseOpencodeModel,
  writeOpencodeConfig,
} from '../src/create/opencode-config.js';

const OPENCODE_REF = 'ghcr.io/getmonoceros/monoceros-features/opencode:1';
const NAME = 'sandbox';

describe('deriveOpencodeProvider', () => {
  it('takes the segment before the first slash', () => {
    expect(deriveOpencodeProvider('anthropic/claude-sonnet-4-6')).toBe(
      'anthropic',
    );
    expect(deriveOpencodeProvider('openai/gpt-4o-mini')).toBe('openai');
  });

  it('returns undefined for empty or prefix-less models', () => {
    expect(deriveOpencodeProvider('')).toBeUndefined();
    expect(deriveOpencodeProvider('claude-sonnet-4-6')).toBeUndefined();
    expect(deriveOpencodeProvider('/leading-slash')).toBeUndefined();
  });
});

describe('parseOpencodeModel', () => {
  it('splits provider and model id, model id may contain slashes', () => {
    expect(parseOpencodeModel('anthropic/claude-sonnet-4-6')).toEqual({
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-6',
    });
    expect(parseOpencodeModel('lmstudio/google/gemma-3n-e4b')).toEqual({
      provider: 'lmstudio',
      modelId: 'google/gemma-3n-e4b',
    });
  });

  it('returns undefined when there is no usable provider/model split', () => {
    expect(parseOpencodeModel('')).toBeUndefined();
    expect(parseOpencodeModel('bare-model')).toBeUndefined();
    expect(parseOpencodeModel('/leading')).toBeUndefined();
    expect(parseOpencodeModel('trailing/')).toBeUndefined();
  });
});

describe('writeOpencodeConfig', () => {
  let dir: string;
  const cfgPath = (): string =>
    path.join(dir, 'home', '.config', 'opencode', 'opencode.json');
  const read = async (): Promise<Record<string, unknown>> =>
    JSON.parse(await fsp.readFile(cfgPath(), 'utf8'));

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mono-opencode-cfg-'));
  });
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('writes model + derived provider key + instructions', async () => {
    await writeOpencodeConfig(dir, NAME, {
      [OPENCODE_REF]: {
        model: 'anthropic/claude-sonnet-4-6',
        apiToken: 'sk-test-123',
      },
    });
    const cfg = await read();
    expect(cfg.$schema).toBe('https://opencode.ai/config.json');
    expect(cfg.model).toBe('anthropic/claude-sonnet-4-6');
    expect(cfg.instructions).toEqual([
      `/workspaces/${NAME}/AGENTS.md`,
      `/workspaces/${NAME}/.monoceros/commands.md`,
    ]);
    const provider = cfg.provider as Record<
      string,
      { options: Record<string, unknown> }
    >;
    expect(provider.anthropic!.options).toEqual({ apiKey: 'sk-test-123' });
  });

  it('omits model and provider when the option is empty (interactive auth)', async () => {
    await writeOpencodeConfig(dir, NAME, {
      [OPENCODE_REF]: { model: '', apiToken: '' },
    });
    const cfg = await read();
    expect(cfg.model).toBeUndefined();
    expect(cfg.provider).toBeUndefined();
    // Instructions are written regardless of auth mode.
    expect(cfg.instructions).toEqual([
      `/workspaces/${NAME}/AGENTS.md`,
      `/workspaces/${NAME}/.monoceros/commands.md`,
    ]);
  });

  it('writes model but no provider key when token is missing', async () => {
    await writeOpencodeConfig(dir, NAME, {
      [OPENCODE_REF]: { model: 'openai/gpt-4o-mini' },
    });
    const cfg = await read();
    expect(cfg.model).toBe('openai/gpt-4o-mini');
    expect(cfg.provider).toBeUndefined();
  });

  it('merges: preserves user keys, other providers, and extra instructions', async () => {
    await fsp.mkdir(path.dirname(cfgPath()), { recursive: true });
    await fsp.writeFile(
      cfgPath(),
      JSON.stringify({
        theme: 'opencode',
        instructions: ['docs/style.md'],
        provider: { openai: { options: { apiKey: 'keep-me' } } },
      }),
    );
    await writeOpencodeConfig(dir, NAME, {
      [OPENCODE_REF]: {
        model: 'anthropic/claude-sonnet-4-6',
        apiToken: 'sk-new',
      },
    });
    const cfg = await read();
    expect(cfg.theme).toBe('opencode');
    // Managed instructions come first, the user's survive and aren't duplicated.
    expect(cfg.instructions).toEqual([
      `/workspaces/${NAME}/AGENTS.md`,
      `/workspaces/${NAME}/.monoceros/commands.md`,
      'docs/style.md',
    ]);
    const provider = cfg.provider as Record<
      string,
      { options: Record<string, unknown> }
    >;
    expect(provider.openai!.options).toEqual({ apiKey: 'keep-me' });
    expect(provider.anthropic!.options).toEqual({ apiKey: 'sk-new' });
  });

  it('custom mode: npm set builds a full provider block with synthesized models', async () => {
    await writeOpencodeConfig(dir, NAME, {
      [OPENCODE_REF]: {
        model: 'ollama/llama3',
        apiToken: '',
        npm: '@ai-sdk/openai-compatible',
        baseUrl: 'http://ollama:11434/v1',
      },
    });
    const cfg = await read();
    expect(cfg.model).toBe('ollama/llama3');
    const provider = cfg.provider as Record<string, Record<string, unknown>>;
    expect(provider.ollama).toEqual({
      npm: '@ai-sdk/openai-compatible',
      name: 'ollama',
      options: { baseURL: 'http://ollama:11434/v1' },
      models: { llama3: { name: 'llama3' } },
    });
  });

  it('custom mode: apiToken becomes options.apiKey for proxies that need it', async () => {
    await writeOpencodeConfig(dir, NAME, {
      [OPENCODE_REF]: {
        model: 'myproxy/some-model',
        apiToken: 'proxy-key',
        npm: '@ai-sdk/openai-compatible',
        baseUrl: 'https://proxy.example/v1',
      },
    });
    const cfg = await read();
    const provider = cfg.provider as Record<
      string,
      { options: Record<string, unknown> }
    >;
    expect(provider.myproxy!.options).toEqual({
      baseURL: 'https://proxy.example/v1',
      apiKey: 'proxy-key',
    });
  });

  it('hosted mode: an unknown provider without npm writes no provider block', async () => {
    // model points at a local provider but npm/baseUrl are missing → we
    // must not emit a half-baked provider block (the apply warns instead).
    await writeOpencodeConfig(dir, NAME, {
      [OPENCODE_REF]: { model: 'ollama/llama3', apiToken: 'whatever' },
    });
    const cfg = await read();
    expect(cfg.model).toBe('ollama/llama3');
    expect(cfg.provider).toBeUndefined();
  });

  it('custom mode: npm set but model empty writes no provider block', async () => {
    await writeOpencodeConfig(dir, NAME, {
      [OPENCODE_REF]: { model: '', npm: '@ai-sdk/openai-compatible' },
    });
    const cfg = await read();
    expect(cfg.provider).toBeUndefined();
  });

  it('is a no-op when no opencode feature is present', async () => {
    const { existsSync } = await import('node:fs');
    await writeOpencodeConfig(dir, NAME, {
      'ghcr.io/getmonoceros/monoceros-features/claude-code:1': {},
    });
    expect(existsSync(cfgPath())).toBe(false);
  });
});
