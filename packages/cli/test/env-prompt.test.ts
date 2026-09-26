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
// prompt: the one intro line that explained it went unread, and every key got
// the same bare question. So each prompt now says where its value already is,
// in the order apply resolves it.
describe('envValueState', () => {
  it('prefers the container file, as apply does', () => {
    expect(
      envValueState(
        'K',
        { K: 'global-value-1234' },
        { K: 'container-value-9876' },
      ),
    ).toEqual({ source: 'container', tail: ' (…9876)' });
  });

  it('falls through a blank container key to the global one', () => {
    expect(envValueState('K', { K: 'global-value-1234' }, { K: '  ' })).toEqual(
      { source: 'global', tail: ' (…1234)' },
    );
  });

  it('shows no tail for a short value', () => {
    expect(envValueState('K', { K: 'acme' }, {})).toEqual({
      source: 'global',
      tail: '',
    });
  });

  it('is none when neither file has it', () => {
    expect(envValueState('K', {}, {})).toEqual({ source: 'none' });
  });
});

describe('envPromptText', () => {
  it('says a global value is kept on Enter, and keeps the description', () => {
    const { message, placeholder } = envPromptText(
      KEY,
      { source: 'global', tail: ' (…a1b2)' },
      PATHS,
    );
    expect(message).toBe(
      'CLAUDE_CODE_API_KEY (Claude Code) is set in ~/.monoceros/monoceros-config.env (…a1b2)\n' +
        'ℹ `sk-ant-…` for API auth; empty for OAuth login on first run.',
    );
    expect(placeholder).toBe(
      'Enter keeps it, or type a different value for ccr only',
    );
  });

  it('says where to fill in a value that is not set anywhere', () => {
    const { message, placeholder } = envPromptText(
      KEY,
      { source: 'none' },
      PATHS,
    );
    expect(message).toContain('is not set yet');
    expect(placeholder).toBe(
      'Enter skips it, fill it in later in ~/.monoceros/container-configs/ccr.env',
    );
  });
});

describe('promptForEnvValues', () => {
  it('ends with where each value came from', async () => {
    const info: string[] = [];
    const ok: string[] = [];
    const answers = await promptForEnvValues(
      [KEY, { envVar: 'GH_TOKEN', feature: 'GitHub CLI', description: '' }],
      {
        interactive: true,
        ...PATHS,
        globalValues: { CLAUDE_CODE_API_KEY: 'sk-ant-global-a1b2' },
        ask: async () => '',
        output: (l) => info.push(l),
        success: (l) => ok.push(l),
      },
    );
    expect(answers).toEqual({});
    expect(info[0]).toBe('ccr needs 2 values.');
    expect(ok).toEqual([
      'CLAUDE_CODE_API_KEY  global (~/.monoceros/monoceros-config.env)',
    ]);
    expect(info[1]).toBe(
      'GH_TOKEN             empty, fill it in later in ~/.monoceros/container-configs/ccr.env',
    );
  });

  it('reports a typed value as the workbench own', async () => {
    const ok: string[] = [];
    const answers = await promptForEnvValues([KEY], {
      interactive: true,
      ...PATHS,
      globalValues: { CLAUDE_CODE_API_KEY: 'sk-ant-global-a1b2' },
      ask: async () => 'sk-ant-other-z9y8',
      output: () => {},
      success: (l) => ok.push(l),
    });
    expect(answers).toEqual({ CLAUDE_CODE_API_KEY: 'sk-ant-other-z9y8' });
    expect(ok).toEqual([
      'CLAUDE_CODE_API_KEY  for ccr (~/.monoceros/container-configs/ccr.env)',
    ]);
  });
});
