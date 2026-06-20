import { describe, expect, it } from 'vitest';
import { main } from '../src/main.js';

describe('monoceros main command', () => {
  it('declares CLI metadata', () => {
    expect(main.meta).toMatchObject({
      name: 'monoceros',
      version: expect.any(String),
      description: expect.any(String),
    });
  });

  it('registers the M1 + M2.5 subcommand surface plus the M4 completion command', async () => {
    const expected = [
      'init',
      'list-components',
      'shell',
      'open',
      'run',
      'logs',
      'start',
      'stop',
      'status',
      'apply',
      'upgrade',
      'remove',
      'restore',
      'add-service',
      'add-language',
      'add-apt-packages',
      'add-feature',
      'add-from-url',
      'add-repo',
      'add-port',
      'remove-service',
      'remove-language',
      'remove-apt-packages',
      'remove-feature',
      'remove-from-url',
      'remove-repo',
      'remove-port',
      'port',
      'tunnel',
      'completion',
      // Internal helper used by the shell-completion wrappers; not
      // user-facing but part of the registered subcommand surface.
      '__complete',
      // Internal background worker for the self-update notice (ADR-less);
      // hidden, spawned detached by scheduleUpdateNotice.
      '__update-check',
      // Internal host-side browser-bridge daemon (ADR 0022 follow-up);
      // hidden, spawned detached by apply/start.
      '__bridge',
    ];

    const subCommands = main.subCommands;
    expect(subCommands).toBeDefined();
    expect(Object.keys(subCommands!).sort()).toEqual(expected.sort());
  });

  it('every subcommand resolves to a definition with name + description', async () => {
    const subCommands = main.subCommands ?? {};
    for (const [key, factory] of Object.entries(subCommands)) {
      const resolved =
        typeof factory === 'function' ? await factory() : await factory;
      const meta =
        typeof resolved.meta === 'function'
          ? await resolved.meta()
          : resolved.meta;
      expect(meta?.name, `subcommand ${key} is missing meta.name`).toBeTruthy();
      expect(
        meta?.description,
        `subcommand ${key} is missing meta.description`,
      ).toBeTruthy();
    }
  });
});
