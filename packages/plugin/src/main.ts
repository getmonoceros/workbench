#!/usr/bin/env -S node --experimental-strip-types
import { createLocalFindingsStore } from '@monoceros/adapter-local';
import { defineCommand, runMain } from 'citty';
import { consola } from 'consola';

import { deferConcern } from './defer.js';
import { runIterateCommand, summarizeOutcome } from './iterate.js';
import { renderList } from './list.js';
import { findSolutionRoot } from './locate.js';
import { parseTriageStatus, triageItem } from './triage.js';

const iterate = defineCommand({
  meta: {
    name: 'iterate',
    description: 'Run one Plan/Generate/Review iteration.',
  },
  args: {
    prompt: {
      type: 'positional',
      description: 'Builder prompt for this iteration.',
    },
  },
  async run({ args }) {
    const prompt = requirePositional(args.prompt, 'prompt');
    const root = await findSolutionRoot(process.cwd());
    const store = createLocalFindingsStore({ solutionRoot: root });
    const outcome = await runIterateCommand(store, {
      userPrompt: prompt,
      cwd: root,
    });
    consola.log(summarizeOutcome(outcome));
    if (!outcome.result.ok) process.exit(1);
  },
});

const list = defineCommand({
  meta: {
    name: 'list',
    description: 'List captured findings, concerns and risks.',
  },
  args: {
    all: {
      type: 'boolean',
      description: 'Include triaged items (jetzt/später/verworfen).',
      default: false,
    },
  },
  async run({ args }) {
    const root = await findSolutionRoot(process.cwd());
    const store = createLocalFindingsStore({ solutionRoot: root });
    const text = await renderList({ store, all: args.all });
    consola.log(text);
  },
});

const triage = defineCommand({
  meta: { name: 'triage', description: 'Mark an item with a triage status.' },
  args: {
    id: { type: 'positional', description: 'Item id (filename without .md).' },
    status: {
      type: 'positional',
      description: 'jetzt | später | verworfen',
    },
  },
  async run({ args }) {
    const id = requirePositional(args.id, 'id');
    const statusArg = requirePositional(args.status, 'status');
    const root = await findSolutionRoot(process.cwd());
    const store = createLocalFindingsStore({ solutionRoot: root });
    const status = parseTriageStatus(statusArg);
    const message = await triageItem(store, id, status);
    consola.log(message);
  },
});

const defer = defineCommand({
  meta: {
    name: 'defer',
    description: 'Capture a manual concern outside of an iteration.',
  },
  args: {
    text: { type: 'positional', description: 'The concern text.' },
  },
  async run({ args }) {
    const text = requirePositional(args.text, 'text');
    const root = await findSolutionRoot(process.cwd());
    const store = createLocalFindingsStore({ solutionRoot: root });
    const id = await deferConcern(store, text);
    consola.log(`Concern captured: ${id}`);
  },
});

function requirePositional(value: string | undefined, name: string): string {
  if (value === undefined || value === '') {
    consola.error(`Missing required argument: ${name}`);
    process.exit(2);
  }
  return value;
}

const main = defineCommand({
  meta: {
    name: 'monoceros-plugin',
    version: '0.1.0-dev',
    description:
      'Monoceros plugin CLI. Invoked by the Claude Code slash commands.',
  },
  subCommands: { iterate, list, triage, defer },
});

runMain(main);
