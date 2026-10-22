import { describe, expect, it } from 'vitest';
import { logFileCommand } from '../src/commands/logs.js';

describe('logFileCommand (#131)', () => {
  it('follows from the first line, not from the last ten', () => {
    expect(logFileCommand('/l/backend.log', true)).toEqual([
      'tail',
      ['-n', '+1', '-F', '/l/backend.log'],
    ]);
  });

  it('dumps the whole file once without follow', () => {
    expect(logFileCommand('/l/backend.log', false)).toEqual([
      'cat',
      ['/l/backend.log'],
    ]);
  });
});
