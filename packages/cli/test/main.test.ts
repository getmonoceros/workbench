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

  it('registers the M1 + M2.5 subcommand surface', async () => {
    const expected = [
      'create',
      'shell',
      'run',
      'logs',
      'start',
      'stop',
      'down',
      'status',
      'apply',
      'add-service',
      'add-language',
      'add-apt-packages',
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
