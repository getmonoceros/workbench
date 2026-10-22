import { describe, expect, it } from 'vitest';
import {
  createPullProgress,
  formatBytes,
} from '../src/devcontainer/pull-progress.js';

// Lines as `docker compose --progress json pull` writes them (Compose v5.3.0),
// shortened from a real pull of redis:7.4-alpine next to an alpine that was
// already current.
const REDIS = 'Image redis:7.4-alpine';
const event = (e: Record<string, unknown>) => `${JSON.stringify(e)}\n`;
const layer = (id: string, e: Record<string, unknown>) =>
  event({ id, parent_id: REDIS, ...e });

function run(lines: string[], interval = 5000) {
  const log: string[] = [];
  const status: string[] = [];
  const errors: [string, string][] = [];
  let clock = 0;
  const sink = createPullProgress({
    log: (l) => log.push(l),
    onStatus: (s) => status.push(s),
    onError: (i, r) => errors.push([i, r]),
    logIntervalMs: interval,
    now: () => clock,
  });
  for (const line of lines) {
    clock += 1000;
    sink.write(line);
  }
  sink.end();
  return { log, status, errors };
}

describe('createPullProgress (#137)', () => {
  const pull = [
    event({ id: 'Image alpine:3.21', status: 'Working', text: 'Pulling' }),
    event({ id: REDIS, status: 'Working', text: 'Pulling' }),
    event({ id: 'Image alpine:3.21', status: 'Done', text: 'Pulled' }),
    layer('aaa', { status: 'Working', text: 'Pulling fs layer' }),
    layer('bbb', { status: 'Working', text: 'Pulling fs layer' }),
    layer('aaa', {
      status: 'Working',
      text: 'Downloading',
      current: 1048576,
      total: 12580030,
    }),
    layer('bbb', {
      status: 'Working',
      text: 'Downloading',
      current: 500000,
      total: 3000000,
    }),
    layer('bbb', { status: 'Done', text: 'Pull complete' }),
    layer('aaa', {
      status: 'Working',
      text: 'Downloading',
      current: 6291456,
      total: 12580030,
    }),
    layer('aaa', { status: 'Done', text: 'Pull complete' }),
    event({ id: REDIS, status: 'Done', text: 'Pulled' }),
  ];

  it('tells the spinner which image loads and how far it is', () => {
    const { status } = run(pull);
    expect(status).toContain(
      'pulling redis:7.4-alpine · 1.0 MB of 13 MB · 0 of 2 layers',
    );
    expect(status).toContain(
      'pulling redis:7.4-alpine · 9.3 MB of 16 MB · 1 of 2 layers',
    );
  });

  it('logs a pulled image with its size and a current one as current', () => {
    const { log } = run(pull, 60_000);
    expect(log).toContain('alpine:3.21 is already current');
    expect(log).toContain('Pulled redis:7.4-alpine (16 MB)');
  });

  it('logs progress at most once per interval per image', () => {
    const progress = (interval: number) =>
      run(pull, interval).log.filter((l) => l.startsWith('Pulling '));
    expect(progress(60_000)).toHaveLength(1);
    expect(progress(1000).length).toBeGreaterThan(1);
  });

  it('shows only the layer count before any layer knows its size', () => {
    const { status } = run(pull.slice(0, 5));
    expect(status.at(-1)).toBe('pulling redis:7.4-alpine · 0 of 2 layers');
  });

  it('drops the registry host from the spinner line', () => {
    const { status } = run([
      event({
        id: 'Image mcr.microsoft.com/mssql/server:2025-latest',
        status: 'Working',
        text: 'Pulling',
      }),
    ]);
    expect(status).toEqual(['pulling mssql/server:2025-latest']);
  });

  it('reports a failed image with the first line of the reason', () => {
    const { log, errors } = run([
      event({
        id: 'Image ghcr.io/acme/app/pdf:latest',
        status: 'Error',
        text: 'Error',
        details: 'error from registry: unauthorized\nunauthorized',
      }),
    ]);
    expect(errors).toEqual([
      ['ghcr.io/acme/app/pdf:latest', 'error from registry: unauthorized'],
    ]);
    expect(log).toEqual([
      'Could not pull ghcr.io/acme/app/pdf:latest: error from registry: unauthorized',
    ]);
  });

  it('passes lines through that are not compose JSON, split across chunks', () => {
    const log: string[] = [];
    const sink = createPullProgress({ log: (l) => log.push(l) });
    sink.write('no such ser');
    sink.write('vice: pdf\n');
    sink.end();
    expect(log).toEqual(['no such service: pdf']);
  });
});

describe('formatBytes', () => {
  it('reads like docker: kB, one decimal below 10 MB, whole MB above', () => {
    expect(formatBytes(840_000)).toBe('840 kB');
    expect(formatBytes(1_048_576)).toBe('1.0 MB');
    expect(formatBytes(605_000_000)).toBe('605 MB');
  });
});
