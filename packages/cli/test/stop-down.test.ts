import { describe, expect, it } from 'vitest';
import { downConflict } from '../src/commands/stop.js';

describe('downConflict (stop --down, #114)', () => {
  it('allows --down for the whole container', () => {
    expect(downConflict('acme', undefined, undefined)).toBeUndefined();
  });

  it('rejects --down together with an app and names the command that works', () => {
    const msg = downConflict('acme', 'web', undefined);
    expect(msg).toContain("can't be limited to an app");
    expect(msg).toContain("'monoceros stop acme web'");
  });

  it('rejects --down together with --service and names the command that works', () => {
    const msg = downConflict('acme', undefined, 'postgres');
    expect(msg).toContain("can't be limited to one service");
    expect(msg).toContain("'monoceros stop acme --service postgres'");
  });
});
