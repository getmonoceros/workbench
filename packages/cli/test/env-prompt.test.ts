import { describe, expect, it } from 'vitest';
import {
  envPromptText,
  envValueState,
  promptForEnvValues,
  type EnvPromptCandidate,
} from '../src/init/env-prompt.js';

const KEY: EnvPromptCandidate = {
  envVar: 'CLAUDE_CODE_API_KEY',
  feature: 'Claude Code',
  description: '`sk-ant-…` for API auth; empty for OAuth login on first run.',
};
const PATHS = {
  name: 'ccr',
  globalEnvPath: '~/.monoceros/monoceros-config.env',
  containerEnvPath: '~/.monoceros/container-configs/ccr.env',
};

// Builders kept asking "but it is already in monoceros-config.env?" at this
// prompt, first because every key got the same bare question, then because a
// key they keep in the shared file was still asked on every init and add-*.
// So a value that is already set is not asked again; the summary says where it
// comes from, in the order apply resolves it.
describe('envValueState', () => {
  it('prefers the container file, as apply does', () => {
    expect(
      envValueState(
        'K',
        { K: 'global-value-1234' },
        { K: 'container-value-9876' },
      ),
    ).toEqual({ source: 'container' });
  });

  it('falls through a blank container key to the global one', () => {
    expect(envValueState('K', { K: 'global-value-1234' }, { K: '  ' })).toEqual(
      { source: 'global' },
    );
  });

  it('is none when neither file has it', () => {
    expect(envValueState('K', {}, {})).toEqual({ source: 'none' });
  });
});

describe('envPromptText', () => {
  it('says where to fill in a value that is not set anywhere', () => {
    const { message, placeholder } = envPromptText(KEY, PATHS);
    expect(message).toBe(
      'CLAUDE_CODE_API_KEY (Claude Code) is not set yet\n' +
        'ℹ `sk-ant-…` for API auth; empty for OAuth login on first run.',
    );
    expect(placeholder).toBe(
      'Enter skips it, fill it in later in ~/.monoceros/container-configs/ccr.env',
    );
  });
});

describe('promptForEnvValues', () => {
  it('asks only for what is not set, and says where the rest comes from', async () => {
    const info: string[] = [];
    const ok: string[] = [];
    const asked: string[] = [];
    const answers = await promptForEnvValues(
      [KEY, { envVar: 'GH_TOKEN', feature: 'GitHub CLI', description: '' }],
      {
        interactive: true,
        ...PATHS,
        globalValues: { CLAUDE_CODE_API_KEY: 'sk-ant-global-a1b2' },
        ask: async (c) => {
          asked.push(c.envVar);
          return '';
        },
        output: (l) => info.push(l),
        success: (l) => ok.push(l),
      },
    );
    expect(asked).toEqual(['GH_TOKEN']);
    expect(answers).toEqual({});
    expect(info[0]).toBe('ccr needs 1 value.');
    expect(ok).toEqual([
      'CLAUDE_CODE_API_KEY  global (~/.monoceros/monoceros-config.env)',
    ]);
    expect(info[1]).toBe(
      'GH_TOKEN             empty, fill it in later in ~/.monoceros/container-configs/ccr.env',
    );
  });

  it('asks nothing when every value is already set', async () => {
    const info: string[] = [];
    const ok: string[] = [];
    await promptForEnvValues([KEY], {
      interactive: true,
      ...PATHS,
      globalValues: { CLAUDE_CODE_API_KEY: 'sk-ant-global-a1b2' },
      ask: async () => {
        throw new Error('asked for a value that is already set');
      },
      output: (l) => info.push(l),
      success: (l) => ok.push(l),
    });
    expect(info).toEqual([]);
    expect(ok).toEqual([
      'CLAUDE_CODE_API_KEY  global (~/.monoceros/monoceros-config.env)',
    ]);
  });

  it('reports a typed value as the workbench own', async () => {
    const ok: string[] = [];
    const info: string[] = [];
    const answers = await promptForEnvValues([KEY], {
      interactive: true,
      ...PATHS,
      ask: async () => 'sk-ant-other-z9y8',
      output: (l) => info.push(l),
      success: (l) => ok.push(l),
    });
    expect(answers).toEqual({ CLAUDE_CODE_API_KEY: 'sk-ant-other-z9y8' });
    expect(ok).toEqual([
      'CLAUDE_CODE_API_KEY  for ccr (~/.monoceros/container-configs/ccr.env)',
    ]);
    expect(info).toEqual(['ccr needs 1 value.']);
  });
});
