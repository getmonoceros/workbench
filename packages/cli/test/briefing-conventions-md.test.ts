import { describe, expect, it } from 'vitest';
import { generateConventionsMd } from '../src/briefing/conventions-md.js';

describe('.monoceros/conventions.md generator', () => {
  it('carries the long form of the workspace and language rules', () => {
    const md = generateConventionsMd({ containerName: 'demo' });
    expect(md).toContain('# Conventions and pitfalls');
    // The agent must build under projects/, not at the workspace root.
    expect(md).toContain('Build everything under `/workspaces/demo/projects/`');
    // Self-scaffolded projects must be registered in the workspace file so
    // VS Code opened from the host lists them (clones get added by apply).
    expect(md).toContain('Register new projects in `demo.code-workspace`');
    expect(md).toContain('/workspaces/demo/demo.code-workspace');
    expect(md).toContain('{ "path": "projects/<app>", "name": "<app>" }');
    // One root per top-level dir under projects/, not per sub-project,
    // so the Explorer stays readable as more projects land.
    expect(md).toContain(
      'Add **exactly one** folder entry per directory directly under `projects/`',
    );
    expect(md).toContain(
      '- **Write everything that goes into the repo in English**',
    );
    // Chat language is the user's; only what lands in the repo is fixed, and
    // the user can override it for the whole project.
    expect(md).toContain('Talk to the user in whatever language they use.');
    expect(md).toContain('If they want the project in another language');
    expect(md).toContain('monoceros tunnel demo <service>');
  });
});
