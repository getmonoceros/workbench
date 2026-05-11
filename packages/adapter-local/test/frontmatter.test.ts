import { describe, expect, it } from 'vitest';

import { parseFile, stringifyFile } from '../src/index.js';

describe('frontmatter codec', () => {
  it('round-trips primitives, arrays and nested objects losslessly', () => {
    const data = {
      id: 'abc',
      severity: 'high',
      blocking: true,
      line: 42,
      tags: ['routing', 'build'],
      meta: { who: 'reviewer', when: 5 },
    };
    const serialized = stringifyFile(data, 'Body text here.');
    const parsed = parseFile(serialized);
    expect(parsed.frontmatter).toEqual(data);
    expect(parsed.body).toBe('Body text here.\n');
  });

  it('writes JSON-encoded values', () => {
    const out = stringifyFile({ name: 'foo: with colon' }, 'x');
    expect(out).toContain('name: "foo: with colon"');
  });

  it('skips undefined values', () => {
    const out = stringifyFile(
      { id: 'a', suggestion: undefined, severity: 'low' },
      'x',
    );
    expect(out).not.toContain('suggestion');
  });

  it('preserves multi-line body content', () => {
    const body = 'Line 1\n\nLine 3\n  indented line';
    const serialized = stringifyFile({ id: 'x' }, body);
    const parsed = parseFile(serialized);
    expect(parsed.body.trimEnd()).toBe(body);
  });

  it('throws on missing opening delimiter', () => {
    expect(() => parseFile('id: "x"\n---\nbody')).toThrow(/opening/);
  });

  it('throws on missing closing delimiter', () => {
    expect(() => parseFile('---\nid: "x"\nbody without close')).toThrow(
      /closing/,
    );
  });

  it('throws on a non-JSON value', () => {
    expect(() => parseFile('---\nkey: not json\n---\nbody')).toThrow(
      /not JSON-parseable/,
    );
  });
});
