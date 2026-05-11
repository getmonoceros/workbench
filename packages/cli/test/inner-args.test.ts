import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  consumeInnerArgsFromProcessArgv,
  getInnerArgs,
  setInnerArgsForTesting,
  splitInnerArgs,
} from '../src/inner-args.js';

describe('splitInnerArgs', () => {
  it('returns the slice after the first `--`', () => {
    expect(
      splitInnerArgs(['--project=foo', '--', 'ls', '-la', '/tmp']),
    ).toEqual({
      outerArgs: ['--project=foo'],
      innerArgs: ['ls', '-la', '/tmp'],
    });
  });

  it('returns empty innerArgs when `--` is missing', () => {
    expect(splitInnerArgs(['--project=foo'])).toEqual({
      outerArgs: ['--project=foo'],
      innerArgs: [],
    });
  });

  it('returns empty innerArgs when `--` is the last token', () => {
    expect(splitInnerArgs(['--project=foo', '--'])).toEqual({
      outerArgs: ['--project=foo'],
      innerArgs: [],
    });
  });

  it('preserves --help / --version inside innerArgs verbatim', () => {
    expect(splitInnerArgs(['run', '--', 'monoceros-plugin', '--help'])).toEqual(
      {
        outerArgs: ['run'],
        innerArgs: ['monoceros-plugin', '--help'],
      },
    );
    expect(splitInnerArgs(['run', '--', 'tsx', '--version'])).toEqual({
      outerArgs: ['run'],
      innerArgs: ['tsx', '--version'],
    });
  });

  it('only splits on the first `--`; later `--` stay in innerArgs', () => {
    expect(splitInnerArgs(['run', '--', 'bash', '-c', '--', 'foo'])).toEqual({
      outerArgs: ['run'],
      innerArgs: ['bash', '-c', '--', 'foo'],
    });
  });
});

describe('consumeInnerArgsFromProcessArgv', () => {
  let originalArgv: string[];

  beforeEach(() => {
    originalArgv = process.argv;
    setInnerArgsForTesting([]);
  });

  afterEach(() => {
    process.argv = originalArgv;
    setInnerArgsForTesting([]);
  });

  it('strips `--` and everything after from process.argv', () => {
    process.argv = [
      '/usr/bin/node',
      '/path/to/bin.ts',
      'run',
      '--project=foo',
      '--',
      'monoceros-plugin',
      '--help',
    ];
    consumeInnerArgsFromProcessArgv();
    expect(process.argv).toEqual([
      '/usr/bin/node',
      '/path/to/bin.ts',
      'run',
      '--project=foo',
    ]);
    expect(getInnerArgs()).toEqual(['monoceros-plugin', '--help']);
  });

  it('leaves process.argv intact when `--` is absent', () => {
    process.argv = [
      '/usr/bin/node',
      '/path/to/bin.ts',
      'create',
      'demo',
      '--languages=python',
    ];
    consumeInnerArgsFromProcessArgv();
    expect(process.argv).toEqual([
      '/usr/bin/node',
      '/path/to/bin.ts',
      'create',
      'demo',
      '--languages=python',
    ]);
    expect(getInnerArgs()).toEqual([]);
  });
});
