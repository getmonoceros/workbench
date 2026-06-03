import { describe, expect, it } from 'vitest';
import { collectWithPortsList } from '../src/commands/init.js';

/**
 * Direct tests for the rawArgs walker the init CLI uses to gather
 * `--with-ports` tokens. These are intentionally separate from
 * init.test.ts (which exercises runInit's downstream effects) — the
 * parser has its own failure modes (infinite loops on a too-clever
 * index-rewind, off-by-ones, missing dedupe) that runInit doesn't
 * see because callers feed it an already-parsed number[].
 *
 * Bug history: the first cut of collectWithPortsList rewound `i` to
 * re-check a token, but the rewind landed on the flag itself and the
 * outer loop walked back into it, looping forever. The
 * "doesn't loop forever on `--with-ports=...`" test below pins that.
 */

const TIMEOUT_MS = 1000;

describe('collectWithPortsList', () => {
  it('returns undefined when no --with-ports occurs', () => {
    expect(collectWithPortsList(undefined, ['init', 'demo'])).toBeUndefined();
  });

  it('parses the `=value` form', () => {
    expect(
      collectWithPortsList('3000,5173', [
        'init',
        'demo',
        '--with-ports=3000,5173',
      ]),
    ).toEqual([3000, 5173]);
  });

  it('parses the two-token form', () => {
    expect(
      collectWithPortsList('3000', [
        'init',
        'demo',
        '--with-ports',
        '3000',
        '5173',
      ]),
    ).toEqual([3000, 5173]);
  });

  it('handles shell-tokenization with spaces after commas', () => {
    // `--with-ports=3000, 5173, 6006` shell-tokenizes to
    // [`--with-ports=3000,`, `5173,`, `6006`]. The parser must
    // re-stitch them.
    expect(
      collectWithPortsList('3000,', [
        'init',
        'demo',
        '--with-ports=3000,',
        '5173,',
        '6006',
      ]),
    ).toEqual([3000, 5173, 6006]);
  });

  it('aggregates across multiple --with-ports occurrences', () => {
    expect(
      collectWithPortsList('6006', [
        'init',
        'demo',
        '--with-ports=3000',
        '--with-ports=5173',
        '--with-ports=6006',
      ]),
    ).toEqual([3000, 5173, 6006]);
  });

  it('stops sweeping at the next flag, not into other --with-* options', () => {
    expect(
      collectWithPortsList('3000', [
        'init',
        'demo',
        '--with-ports=3000',
        '5173',
        '--with-languages',
        'node',
      ]),
    ).toEqual([3000, 5173]);
  });

  it('rejects out-of-range values with a usage error', () => {
    expect(() =>
      collectWithPortsList('70000', ['init', 'demo', '--with-ports=70000']),
    ).toThrow(/Invalid port in --with-ports: "70000"/);
  });

  it('rejects non-integer tokens with a usage error', () => {
    expect(() =>
      collectWithPortsList('abc', ['init', 'demo', '--with-ports=abc']),
    ).toThrow(/Invalid port in --with-ports: "abc"/);
  });

  // Regression: an early version walked into an infinite loop because
  // it decremented `i` inside the sweep loop to re-check the current
  // token, which landed it on the flag itself. The outer `i += 1`
  // bumped back into the flag, ad infinitum. v8 OOM'd around 4 GB.
  // Fixed by using a local sweep cursor `j` and assigning `i = j - 1`
  // ONCE at the end. The test fails by timing out (vitest default) or
  // exhausting heap rather than asserting a count — either signal
  // is unambiguous.
  it(
    'does not loop forever on a single --with-ports=… token',
    () => {
      const result = collectWithPortsList('3000,5173,6006', [
        'init',
        'demo',
        '--with-ports=3000,5173,6006',
      ]);
      expect(result).toEqual([3000, 5173, 6006]);
    },
    TIMEOUT_MS,
  );

  it('does not loop forever on the two-token form either', () => {
    const result = collectWithPortsList('3000', [
      'init',
      'demo',
      '--with-ports',
      '3000',
    ]);
    expect(result).toEqual([3000]);
  });
});
