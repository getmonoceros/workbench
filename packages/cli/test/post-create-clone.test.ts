import { describe, expect, it } from 'vitest';
import { buildPostCreateScript } from '../src/create/scaffold.js';
import type { CreateOptions } from '../src/create/types.js';

const base: CreateOptions = {
  name: 'demo',
  languages: [],
  services: [],
};

describe('buildPostCreateScript — repo clone is non-fatal', () => {
  it('soft-fails a failed clone instead of aborting post-create', () => {
    // A private repo without a token (or a transient network blip) must
    // NOT sink the whole apply: everything before the clone already ran,
    // and the CLI promises the container comes up so a token can be set
    // and re-applied. The clone is wrapped so `set -e` doesn't fire, and
    // any partial checkout git left behind is removed so the `[ ! -d ]`
    // guard retries cleanly next time.
    const script = buildPostCreateScript({
      ...base,
      repos: [{ url: 'https://github.com/foo/bar.git', path: 'bar' }],
    });
    expect(script).toContain('set -euo pipefail');
    expect(script).toContain(
      'if ! git clone "https://github.com/foo/bar.git" "projects/bar"; then',
    );
    expect(script).toMatch(/Could not clone bar .* skipping/);
    expect(script).toContain('rm -rf "projects/bar"');
  });

  it('guards the per-repo git identity on the clone actually being present', () => {
    // A soft-failed clone leaves no `projects/<path>/.git`, so the
    // `git -C … config user.*` override must be gated on it — otherwise
    // it would itself abort post-create under `set -e`.
    const script = buildPostCreateScript({
      ...base,
      repos: [
        {
          url: 'https://github.com/foo/bar.git',
          path: 'bar',
          gitUser: { name: 'Ada', email: 'ada@example.com' },
        },
      ],
    });
    expect(script).toContain('if [ -d "projects/bar/.git" ]; then');
    expect(script).toContain('git -C "projects/bar" config user.name "Ada"');
    expect(script).toContain(
      'git -C "projects/bar" config user.email "ada@example.com"',
    );
  });
});
