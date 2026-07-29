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
    expect(claude).toContain('<!-- monoceros:begin -->');
    expect(claude).toContain('<!-- monoceros:end -->');
    expect(claude).toContain('@AGENTS.md');
    expect(claude).toContain('## My own notes');

    const commands = await readFile(
      path.join(dir, '.monoceros', 'commands.md'),
      'utf8',
    );
    expect(commands).toContain('# monoceros — Command reference');
    expect(commands).toContain('### `monoceros apply <name>');

    // The two long chapters are imported, so they have to exist on disk.
    const conventions = await readFile(
      path.join(dir, '.monoceros', 'conventions.md'),
      'utf8',
    );
    expect(conventions).toContain('# Conventions and pitfalls');
    const servers = await readFile(
      path.join(dir, '.monoceros', 'servers.md'),
      'utf8',
    );
    expect(servers).toContain('# Running a long-running server');
    expect(agents).toContain('@.monoceros/conventions.md');
    expect(agents).toContain('@.monoceros/servers.md');
  });

  it('states the line count the finished AGENTS.md really has, user notes included', async () => {
    await writeBriefing({
      targetDir: dir,
      createOpts: { name: 'demo', languages: ['node'], services: [] },
      components: new Map<string, Component>(),
      subCommands,
    });

    const lineCountOf = (s: string): number =>
      s.replace(/\n$/, '').split('\n').length;
    const agentsPath = path.join(dir, 'AGENTS.md');
    const first = await readFile(agentsPath, 'utf8');
    expect(first).toContain(
      `This file is ${lineCountOf(first)} lines long and imports 3 more:`,
    );

    // A user note outside the markers lengthens the file, and the next apply
    // has to say so — an agent that read 100 lines of a file claiming more
    // has a visible contradiction in front of it.
    await writeFile(agentsPath, first + '\n- Note.\n- Another note.\n', 'utf8');
    await writeBriefing({
      targetDir: dir,
      createOpts: { name: 'demo', languages: ['node'], services: [] },
      components: new Map<string, Component>(),
      subCommands,
    });
    const second = await readFile(agentsPath, 'utf8');
    expect(lineCountOf(second)).toBeGreaterThan(lineCountOf(first));
    expect(second).toContain(
      `This file is ${lineCountOf(second)} lines long and imports 3 more:`,
    );
  });

  it('writes .monoceros/deploy.md and imports it from AGENTS.md when a service has a pipeline shape', async () => {
    const { existsSync } = await import('node:fs');
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

    const deploy = await readFile(
      path.join(dir, '.monoceros', 'deploy.md'),
      'utf8',
    );
    expect(deploy).toContain('## postgres');
    expect(deploy).toContain('image: postgres:18');

    const agents = await readFile(path.join(dir, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('@.monoceros/deploy.md');
    expect(existsSync(path.join(dir, '.monoceros', 'deploy.md'))).toBe(true);
  });

  it('removes a stale deploy.md and its import when the last such service leaves', async () => {
    const { existsSync } = await import('node:fs');
    const withPostgres = {
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
    };
    await writeBriefing({
      targetDir: dir,
      createOpts: withPostgres,
      components: new Map(),
      subCommands,
    });
    expect(existsSync(path.join(dir, '.monoceros', 'deploy.md'))).toBe(true);

    await writeBriefing({
      targetDir: dir,
      createOpts: { name: 'demo', languages: [], services: [] },
      components: new Map(),
      subCommands,
    });
    expect(existsSync(path.join(dir, '.monoceros', 'deploy.md'))).toBe(false);
    const agents = await readFile(path.join(dir, 'AGENTS.md'), 'utf8');
    expect(agents).not.toContain('@.monoceros/deploy.md');
  });

  it('writes no deploy.md when no service carries a pipeline shape', async () => {
    const { existsSync } = await import('node:fs');
    await writeBriefing({
      targetDir: dir,
      createOpts: {
        name: 'demo',
        languages: [],
        services: [
          { name: 'weird', image: 'acme/weird:1', env: {}, volumes: [] },
        ],
      },
      components: new Map(),
      subCommands,
    });
    expect(existsSync(path.join(dir, '.monoceros', 'deploy.md'))).toBe(false);
    const agents = await readFile(path.join(dir, 'AGENTS.md'), 'utf8');
    expect(agents).not.toContain('@.monoceros/deploy.md');
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

  it('preserves user notes between marker-aware rewrites of CLAUDE.md', async () => {
    // CLAUDE.md is wrapped in markers too so builders can add
    // Claude-Code-specific rules below the `@AGENTS.md` import line
    // and have them survive re-apply.
    await writeBriefing({
      targetDir: dir,
      createOpts: { name: 'demo', languages: [], services: [] },
      components: new Map(),
      subCommands,
    });
    const initial = await readFile(path.join(dir, 'CLAUDE.md'), 'utf8');
    const edited =
      initial + '\n## Claude-only rules\n\n- Always use plan mode here.\n';
    await writeFile(path.join(dir, 'CLAUDE.md'), edited, 'utf8');

    // Second apply — body of the Monoceros block stays the same
    // (CLAUDE.md is just `@AGENTS.md`), but the file is rewritten and
    // the user notes outside the markers must survive.
    await writeBriefing({
      targetDir: dir,
      createOpts: { name: 'demo', languages: ['node'], services: [] },
      components: new Map(),
      subCommands,
    });

    const final = await readFile(path.join(dir, 'CLAUDE.md'), 'utf8');
    expect(final).toContain('@AGENTS.md');
    expect(final).toContain('Always use plan mode here.');
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
