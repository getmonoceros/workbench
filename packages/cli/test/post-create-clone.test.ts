import { describe, expect, it } from 'vitest';
import {
  buildPostCreateScript,
  globalGitignoreContent,
} from '../src/create/scaffold.js';
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

/**
 * The container-global gitignore, git's `core.excludesFile` for every repo in
 * the container. It is what keeps a tool's build output out of the builder's
 * tree without editing a tracked file: graphify writes `graphify-out/` next to
 * the code it analyses, and an agent told to gitignore that will edit the
 * project's own `.gitignore` and commit it. Moving the output elsewhere is not
 * the alternative - `GRAPHIFY_OUT` exists, but graphify's skill hardcodes the
 * literal path, so the CLI and the skill would part ways.
 */
describe('globalGitignoreContent', () => {
  const GRAPHIFY_REF = 'ghcr.io/getmonoceros/monoceros-features/graphify:1';
  const GH_REF = 'ghcr.io/getmonoceros/monoceros-features/github-cli:1';

  it('excludes the per-app launch-config dir on its own', () => {
    expect(globalGitignoreContent(undefined)).toBe('.monoceros/\n');
    expect(globalGitignoreContent({ [GH_REF]: {} })).toBe('.monoceros/\n');
  });

  it('adds graphify build output when that feature is in the container', () => {
    expect(globalGitignoreContent({ [GH_REF]: {}, [GRAPHIFY_REF]: {} })).toBe(
      '.monoceros/\ngraphify-out/\n',
    );
  });
});
