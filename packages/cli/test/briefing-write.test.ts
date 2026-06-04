import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defineCommand } from 'citty';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeBriefing } from '../src/briefing/index.js';
import type { Component } from '../src/init/components.js';

describe('writeBriefing', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'monoceros-briefing-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const subCommands = {
    apply: defineCommand({
      meta: { name: 'apply', group: 'lifecycle', description: 'apply.' },
      args: { name: { type: 'positional', required: true } },
      run() {},
    }),
  };

  it('writes AGENTS.md with markers, CLAUDE.md as @AGENTS.md, and .monoceros/commands.md', async () => {
    await writeBriefing({
      targetDir: dir,
      createOpts: {
        name: 'demo',
        languages: ['node'],
        services: [],
      },
      components: new Map<string, Component>(),
      subCommands,
    });

    const agents = await readFile(path.join(dir, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('<!-- monoceros:begin -->');
    expect(agents).toContain('<!-- monoceros:end -->');
    expect(agents).toContain('# Monoceros Container — Stack Briefing');
    expect(agents).toContain('monoceros apply demo');
    expect(agents).toContain('## My own notes');

    const claude = await readFile(path.join(dir, 'CLAUDE.md'), 'utf8');
    expect(claude).toBe('@AGENTS.md\n');

    const commands = await readFile(
      path.join(dir, '.monoceros', 'commands.md'),
      'utf8',
    );
    expect(commands).toContain('# monoceros — Command reference');
    expect(commands).toContain('### `monoceros apply <name>');
  });

  it('preserves user notes between marker-aware rewrites of AGENTS.md', async () => {
    // First write — fresh file with full template.
    await writeBriefing({
      targetDir: dir,
      createOpts: { name: 'demo', languages: [], services: [] },
      components: new Map(),
      subCommands,
    });
    // User edits the file: adds a personal note OUTSIDE the markers.
    const initial = await readFile(path.join(dir, 'AGENTS.md'), 'utf8');
    const edited = initial + '\n- Personal: always run lint before commits.\n';
    await writeFile(path.join(dir, 'AGENTS.md'), edited, 'utf8');

    // Second apply — services list changes (add postgres).
    await writeBriefing({
      targetDir: dir,
      createOpts: {
        name: 'demo',
        languages: [],
        services: [
          {
            name: 'postgres',
            image: 'postgres:18',
            port: 5432,
            env: {},
            volumes: [],
          },
        ],
      },
      components: new Map(),
      subCommands,
    });

    const final = await readFile(path.join(dir, 'AGENTS.md'), 'utf8');
    expect(final).toContain('postgres:5432'); // new content inside markers
    expect(final).toContain('Personal: always run lint before commits.'); // user note survived
  });

  it('rewrites AGENTS.md with markers when an existing file has none', async () => {
    // Pre-existing file from some older Monoceros version (no markers).
    await writeFile(path.join(dir, 'AGENTS.md'), '# Old content\n', 'utf8');

    await writeBriefing({
      targetDir: dir,
      createOpts: { name: 'demo', languages: [], services: [] },
      components: new Map(),
      subCommands,
    });

    const out = await readFile(path.join(dir, 'AGENTS.md'), 'utf8');
    expect(out).toContain('<!-- monoceros:begin -->');
    expect(out).not.toContain('# Old content');
  });
});
