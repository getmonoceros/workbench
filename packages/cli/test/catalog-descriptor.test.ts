import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadDescriptorCatalog } from '../src/catalog/load.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'monoceros-descriptors-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Write `components/<categoryDir>/<id>/component.yml` under the temp root. */
async function writeDescriptor(
  categoryDir: 'languages' | 'services' | 'features',
  id: string,
  yml: string,
): Promise<void> {
  const dir = path.join(root, categoryDir, id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'component.yml'), yml, 'utf8');
}

const JAVA = `
id: java
category: language
displayName: Java
description: A JDK plus Maven and Gradle by default.
language:
  feature: ghcr.io/devcontainers/features/java:1
  versions: [latest, 21, 17, 11, 8]
options:
  installMaven: { type: boolean, default: true, surface: yml }
  installGradle: { type: boolean, default: true, surface: yml }
`;

const POSTGRES = `
id: postgres
category: service
displayName: PostgreSQL
description: A PostgreSQL service with dev defaults.
service:
  image: postgres:18
  defaultPort: 5432
  dataMount: /var/lib/postgresql
  healthcheck:
    test: [CMD, pg_isready, -U, monoceros]
    interval: 10s
    retries: 5
  connectionEnv:
    DATABASE_URL: postgresql://x@\${host}:\${port}/x
options:
  POSTGRES_PASSWORD: { type: string, default: monoceros, surface: env }
`;

const CLAUDE = `
id: claude-code
category: feature
displayName: Claude Code
description: Anthropic's CLI coding assistant.
documentationURL: https://docs.anthropic.com/en/docs/claude-code
options:
  apiKey: { type: string, default: "", surface: env }
  permissionMode: { type: string, default: auto, surface: yml, proposals: [auto, ask, edits, bypass] }
feature:
  version: 1.2.0
  persistentHomePaths: [.claude]
  persistentHomeFiles: [{ path: .claude.json, initialContent: "{}\\n" }]
briefing:
  - text: Claude Code CLI (claude) - interactive coding assistant.
`;

describe('loadDescriptorCatalog', () => {
  it('loads a valid language/service/feature descriptor and keys by id', async () => {
    await writeDescriptor('languages', 'java', JAVA);
    await writeDescriptor('services', 'postgres', POSTGRES);
    await writeDescriptor('features', 'claude-code', CLAUDE);

    const catalog = await loadDescriptorCatalog(root);

    expect([...catalog.keys()].sort()).toEqual([
      'claude-code',
      'java',
      'postgres',
    ]);
    expect(catalog.get('java')!.category).toBe('language');
    expect(catalog.get('postgres')!.category).toBe('service');
    expect(catalog.get('claude-code')!.category).toBe('feature');
  });

  it('applies the option default (surface=silent) when omitted', async () => {
    await writeDescriptor(
      'languages',
      'go',
      `
id: go
category: language
displayName: Go
description: The Go toolchain.
language:
  feature: ghcr.io/devcontainers/features/go:1
options:
  golangciLintVersion: { type: string }
`,
    );

    const catalog = await loadDescriptorCatalog(root);
    const opt = catalog.get('go')!.descriptor.options.golangciLintVersion!;
    expect(opt.surface).toBe('silent');
  });

  it('returns an empty map when the root does not exist', async () => {
    const catalog = await loadDescriptorCatalog(
      path.join(root, 'does-not-exist'),
    );
    expect(catalog.size).toBe(0);
  });

  it('rejects more than one category-specific block', async () => {
    await writeDescriptor(
      'languages',
      'bad',
      `
id: bad
category: language
displayName: Bad
description: Has two blocks.
language:
  feature: ghcr.io/devcontainers/features/java:1
service:
  image: postgres:18
`,
    );
    await expect(loadDescriptorCatalog(root)).rejects.toThrow(
      /exactly one of language\/service\/feature/,
    );
  });

  it('rejects a block that does not match the declared category', async () => {
    await writeDescriptor(
      'languages',
      'mismatch',
      `
id: mismatch
category: language
displayName: Mismatch
description: Category says language but block is a service.
service:
  image: postgres:18
`,
    );
    await expect(loadDescriptorCatalog(root)).rejects.toThrow(
      /requires a 'language' block/,
    );
  });

  it('rejects a briefing whenOption that references an unknown option', async () => {
    await writeDescriptor(
      'features',
      'dangling',
      `
id: dangling
category: feature
displayName: Dangling
description: whenOption points at nothing.
feature:
  version: 1.0.0
briefing:
  - { whenOption: nope, text: never emitted }
`,
    );
    await expect(loadDescriptorCatalog(root)).rejects.toThrow(
      /whenOption 'nope' is not a declared option/,
    );
  });

  it('rejects an id that does not match its folder name', async () => {
    await writeDescriptor(
      'languages',
      'rust',
      `
id: not-rust
category: language
displayName: Rust
description: Folder is rust, id is not-rust.
language:
  feature: ghcr.io/devcontainers/features/rust:1
`,
    );
    await expect(loadDescriptorCatalog(root)).rejects.toThrow(
      /must match its folder name 'rust'/,
    );
  });

  it('rejects a descriptor sitting under the wrong category folder', async () => {
    // A service descriptor placed under languages/.
    await writeDescriptor(
      'languages',
      'redis',
      `
id: redis
category: service
displayName: Redis
description: A service under the languages folder.
service:
  image: redis:8
`,
    );
    await expect(loadDescriptorCatalog(root)).rejects.toThrow(
      /sits under 'languages\/'/,
    );
  });

  it('rejects presets on a non-feature', async () => {
    await writeDescriptor(
      'services',
      'redis',
      `
id: redis
category: service
displayName: Redis
description: Presets are feature-only.
service:
  image: redis:8
presets:
  ha: { maxmemory: 1gb }
`,
    );
    await expect(loadDescriptorCatalog(root)).rejects.toThrow(
      /presets are only allowed on features/,
    );
  });

  it('rejects a preset that overrides an undeclared option', async () => {
    await writeDescriptor(
      'features',
      'demo',
      `
id: demo
category: feature
displayName: Demo
description: Preset targets a non-existent option.
options:
  flagA: { type: boolean, default: false }
feature:
  version: 1.0.0
presets:
  variant: { flagB: true }
`,
    );
    await expect(loadDescriptorCatalog(root)).rejects.toThrow(
      /preset 'variant' overrides 'flagB', which is not a declared option/,
    );
  });
});
