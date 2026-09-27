import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CTL_SCRIPT = path.join(
  fileURLToPath(new URL('../../..', import.meta.url)),
  'images/runtime/monoceros-ctl.sh',
);

/** The body of one top-level shell function, `name() {` up to its `}`. */
function shellFunction(source: string, name: string): string {
  const start = source.indexOf(`\n${name}() {`);
  if (start < 0) throw new Error(`no function ${name} in monoceros-ctl.sh`);
  const end = source.indexOf('\n}\n', start);
  return source.slice(start + 1, end + 2);
}

// The script resolves /workspaces at load time, so only the three pid
// helpers are lifted out and run. They read /proc, hence Linux only (the CI
// runners); on macOS the real check is a run in the runtime image.
describe.skipIf(process.platform !== 'linux')(
  'monoceros-ctl pid_alive (#42)',
  () => {
    it('trusts a pid only together with its start time', () => {
      const source = readFileSync(CTL_SCRIPT, 'utf8');
      const helpers = ['proc_start', 'pid_of', 'pid_alive']
        .map((n) => shellFunction(source, n))
        .join('\n');
      const script = [
        'set -euo pipefail',
        helpers,
        'f="$(mktemp)"',
        'sleep 30 & pid=$!',
        'check() { if pid_alive "$f"; then echo "$1 alive"; else echo "$1 dead"; fi; }',
        'printf "%s %s\\n" "$pid" "$(proc_start "$pid")" >"$f"; check stamped',
        // The #42 case: the number is live, but it is another process.
        'printf "%s %s\\n" "$pid" 1 >"$f"; check reused',
        // Written by a runtime before this fix: never trusted.
        'printf "%s\\n" "$pid" >"$f"; check pid-only',
        'echo "pid_of $(pid_of "$f")"',
        'kill "$pid"; wait "$pid" 2>/dev/null || true',
        'printf "%s %s\\n" "$pid" 1 >"$f"; check gone',
        'rm -f "$f"; check missing',
      ].join('\n');
      const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
      expect(result.stderr).toBe('');
      const lines = result.stdout.trim().split('\n');
      expect(lines.filter((l) => !l.startsWith('pid_of'))).toEqual([
        'stamped alive',
        'reused dead',
        'pid-only dead',
        'gone dead',
        'missing dead',
      ]);
      expect(lines).toContainEqual(expect.stringMatching(/^pid_of \d+$/));
    });
  },
);
