import { describe, expect, it } from 'vitest';
import {
  COMPLETION_COMMANDS_FOR_TEST,
  COMPLETION_CONTAINER_COMMANDS_FOR_TEST,
  renderCompletionScript,
} from '../src/commands/completion.js';
import { main } from '../src/main.js';

const wiredSubcommands = Object.keys(
  (main.subCommands ?? {}) as Record<string, unknown>,
).sort();

describe('renderCompletionScript', () => {
  it('lists every wired subcommand in the bash script', () => {
    const bash = renderCompletionScript('bash');
    for (const name of wiredSubcommands) {
      expect(bash).toContain(name);
    }
  });

  it('lists every wired subcommand in the zsh script', () => {
    const zsh = renderCompletionScript('zsh');
    for (const name of wiredSubcommands) {
      expect(zsh).toContain(name);
    }
  });

  it('zsh script starts with the #compdef magic line', () => {
    expect(
      renderCompletionScript('zsh').startsWith('#compdef monoceros\n'),
    ).toBe(true);
  });

  it('bash script registers a completion function via `complete -F`', () => {
    expect(renderCompletionScript('bash')).toMatch(
      /complete -F _monoceros monoceros/,
    );
  });

  it('pwsh script uses Register-ArgumentCompleter', () => {
    expect(renderCompletionScript('pwsh')).toMatch(
      /Register-ArgumentCompleter -Native -CommandName monoceros/,
    );
  });

  it('lists every wired subcommand in the pwsh script', () => {
    const pwsh = renderCompletionScript('pwsh');
    for (const name of wiredSubcommands) {
      expect(pwsh).toContain(name);
    }
  });

  it("emits container-name completion for every container-arg command in zsh's case branch", () => {
    const zsh = renderCompletionScript('zsh');
    for (const name of COMPLETION_CONTAINER_COMMANDS_FOR_TEST) {
      // Each name appears in the regex alternation passed to `case`.
      expect(zsh).toMatch(new RegExp(`\\b${name}\\b`));
    }
    // And the container-lookup code is present
    expect(zsh).toContain('container-configs');
  });

  it("emits container-name completion for every container-arg command in bash's case branch", () => {
    const bash = renderCompletionScript('bash');
    for (const name of COMPLETION_CONTAINER_COMMANDS_FOR_TEST) {
      expect(bash).toMatch(new RegExp(`\\b${name}\\b`));
    }
    expect(bash).toContain('container-configs');
  });
});

describe('completion command registry', () => {
  it('ALL_COMMANDS in completion.ts matches every wired subcommand in main.ts', () => {
    // This is the contract that keeps Tab-completion honest as new
    // commands get added. If it fails: add the new command to
    // ALL_COMMANDS (and to COMMANDS_WITH_CONTAINER_ARG if applicable).
    const completionList = [...COMPLETION_COMMANDS_FOR_TEST].sort();
    expect(completionList).toEqual(wiredSubcommands);
  });

  it('COMMANDS_WITH_CONTAINER_ARG only lists commands that exist', () => {
    for (const name of COMPLETION_CONTAINER_COMMANDS_FOR_TEST) {
      expect(wiredSubcommands).toContain(name);
    }
  });

  it("init isn't in COMMANDS_WITH_CONTAINER_ARG (it takes a fresh name)", () => {
    expect(COMPLETION_CONTAINER_COMMANDS_FOR_TEST).not.toContain('init');
  });

  it("list-components isn't in COMMANDS_WITH_CONTAINER_ARG (no positional)", () => {
    expect(COMPLETION_CONTAINER_COMMANDS_FOR_TEST).not.toContain(
      'list-components',
    );
  });

  it("completion isn't in COMMANDS_WITH_CONTAINER_ARG (takes a shell name)", () => {
    expect(COMPLETION_CONTAINER_COMMANDS_FOR_TEST).not.toContain('completion');
  });
});
