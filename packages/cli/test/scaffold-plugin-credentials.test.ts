import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeScaffold } from '../src/create/scaffold.js';
import { solutionConfigToCreateOptions } from '../src/config/transform.js';
import { parseConfig } from '../src/config/index.js';
import type { CreateOptions } from '../src/create/types.js';

/**
 * The in-container clone reads its credentials through git's `store` helper,
 * and the helper is wired in post-create. It used to be wired only when a repo
 * was declared, which left a workbench whose only https clone is an agent
 * plugin marketplace with a credentials file nothing read: the clone then died
 * with `fatal: unable to get password from user`, and a token in the env made
 * no difference.
 */

const tmpDirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    tmpDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })),
  );
});

async function postCreateOf(opts: CreateOptions): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'monoceros-scaffold-'));
  tmpDirs.push(dir);
  await writeScaffold(opts, dir);
  return fs.readFile(path.join(dir, '.devcontainer', 'post-create.sh'), 'utf8');
}

const HELPER =
  'git config --global credential.helper "store --file=/workspaces/sandbox/.monoceros/git-credentials"';

describe('git credential helper in post-create', () => {
  it('is wired for a workbench whose only https clone is a plugin marketplace', async () => {
    const script = await postCreateOf({
      name: 'sandbox',
      languages: [],
      services: [],
      pluginMarketplaceUrls: ['https://github.com/acme/claude-plugins.git'],
    });
    expect(script).toContain(HELPER);
  });

  it('is still wired for a workbench with an https repo and no plugins', async () => {
    const script = await postCreateOf({
      name: 'sandbox',
      languages: [],
      services: [],
      repos: [{ url: 'https://github.com/acme/app.git', path: 'app' }],
    });
    expect(script).toContain(HELPER);
  });

  it('is left out when nothing clones over https', async () => {
    const script = await postCreateOf({
      name: 'sandbox',
      languages: [],
      services: [],
    });
    expect(script).not.toContain('credential.helper');
  });

  it('reaches the scaffold from the yml, without apply having to pass it', () => {
    const yml = [
      'schemaVersion: 1',
      'name: sandbox',
      'features:',
      '  - ref: ghcr.io/getmonoceros/monoceros-features/claude-code:1',
      '    plugins:',
      '      - url: https://github.com/acme/claude-plugins.git',
      '        enable:',
      '          - acme-conventions',
      // A local marketplace is not cloned, so it must not pull the helper in.
      '      - path: house-plugins',
      '        enable:',
      '          - house-conventions',
      '',
    ].join('\n');
    const created = solutionConfigToCreateOptions(parseConfig(yml).config);
    expect(created.pluginMarketplaceUrls).toEqual([
      'https://github.com/acme/claude-plugins.git',
    ]);
  });
});
