import { describe, expect, it } from 'vitest';

import { makeItemId, slugify, timestampPrefix } from '../src/index.js';

describe('slugify', () => {
  it('lowercases and replaces non-alphanumerics with hyphens', () => {
    expect(slugify('Build fehlschlägt — App kann nicht starten')).toBe(
      'build-fehlschlagt-app-kann-nicht-starten',
    );
  });

  it('collapses repeated hyphens', () => {
    expect(slugify('foo --- bar')).toBe('foo-bar');
  });

  it('trims leading and trailing hyphens', () => {
    expect(slugify('---foo---')).toBe('foo');
  });

  it('truncates to 40 characters and re-trims trailing hyphen', () => {
    const long = 'a'.repeat(60);
    expect(slugify(long).length).toBeLessThanOrEqual(40);
  });

  it('returns "item" for empty or all-non-alphanumeric input', () => {
    expect(slugify('')).toBe('item');
    expect(slugify('!!!')).toBe('item');
  });
});

describe('timestampPrefix', () => {
  it('produces a filesystem-safe ISO timestamp', () => {
    const date = new Date('2026-05-11T20:30:12.456Z');
    expect(timestampPrefix(date)).toBe('2026-05-11T20-30-12-456Z');
  });
});

describe('makeItemId', () => {
  it('combines timestamp, random suffix and slug', () => {
    const date = new Date('2026-05-11T20:30:12.456Z');
    expect(makeItemId(date, 'abc123', 'foo-bar')).toBe(
      '2026-05-11T20-30-12-456Z-abc123-foo-bar',
    );
  });
});
