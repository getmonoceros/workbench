import { describe, expect, it } from 'vitest';
import type { CreateOptions } from '../src/create/types.js';
import {
  buildApplySummary,
  formatApplySummary,
} from '../src/apply/apply-summary.js';
import { stripAnsi } from '../src/util/format.js';

function baseOpts(overrides: Partial<CreateOptions> = {}): CreateOptions {
  return {
    name: 'x',
    languages: [],
    services: [],
    postCreateCommand: '',
    ...overrides,
  } as CreateOptions;
}

describe('buildApplySummary', () => {
  it('returns empty array when nothing is configured', () => {
    expect(buildApplySummary(baseOpts())).toEqual([]);
  });

  it('lists features by short name (last path segment, tag stripped)', () => {
    const lines = buildApplySummary(
      baseOpts({
        features: {
          'ghcr.io/getmonoceros/monoceros-features/claude-code:1': {},
          'ghcr.io/getmonoceros/monoceros-features/atlassian:1': {},
        },
      }),
    );
    expect(lines).toEqual([
      { label: 'Features', values: ['claude-code', 'atlassian'] },
    ]);
  });

  it('lists services by name', () => {
    const lines = buildApplySummary(
      baseOpts({
        services: [
          { name: 'postgres', image: 'postgres:16', env: {}, volumes: [] },
          { name: 'redis', image: 'redis:7', env: {}, volumes: [] },
        ],
      }),
    );
    expect(lines).toEqual([
      { label: 'Services', values: ['postgres', 'redis'] },
    ]);
  });

  it('lists repositories by last path segment', () => {
    const lines = buildApplySummary(
      baseOpts({
        repos: [
          { url: 'https://github.com/foo/bar.git', path: 'bar' },
          { url: 'https://github.com/foo/multi.git', path: 'apps/web' },
        ],
      }),
    );
    expect(lines).toEqual([{ label: 'Repositories', values: ['bar', 'web'] }]);
  });

  it('lists ports as strings', () => {
    const lines = buildApplySummary(baseOpts({ ports: [3000, 5173] }));
    expect(lines).toEqual([{ label: 'Ports', values: ['3000', '5173'] }]);
  });

  it('omits sections that are empty', () => {
    const lines = buildApplySummary(
      baseOpts({
        languages: ['node'],
        ports: [],
        aptPackages: [],
        features: {},
      }),
    );
    expect(lines).toEqual([{ label: 'Languages', values: ['node'] }]);
  });

  it('emits all sections in a stable order', () => {
    const lines = buildApplySummary(
      baseOpts({
        languages: ['node'],
        services: [{ name: 'postgres', image: 'p:16', env: {}, volumes: [] }],
        features: { 'ghcr.io/x/y/claude-code:1': {} },
        repos: [{ url: 'u', path: 'r' }],
        ports: [3000],
        aptPackages: ['make'],
        installUrls: ['https://example.com/install.sh'],
      }),
    );
    expect(lines.map((l) => l.label)).toEqual([
      'Languages',
      'Services',
      'Features',
      'Repositories',
      'Ports',
      'APT packages',
      'Install URLs',
    ]);
  });
});

describe('formatApplySummary', () => {
  it('aligns labels to the widest label', () => {
    const formatted = formatApplySummary([
      { label: 'Ports', values: ['3000'] },
      { label: 'APT packages', values: ['make', 'openssl'] },
    ]);
    const plain = stripAnsi(formatted);
    expect(plain).toBe(
      '  Ports         3000\n' + '  APT packages  make, openssl',
    );
  });

  it('returns empty string when no lines', () => {
    expect(formatApplySummary([])).toBe('');
  });
});
