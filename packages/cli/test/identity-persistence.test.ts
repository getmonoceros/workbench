import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';
import {
  writeDescriptor,
  nodeLanguageDescriptor,
} from './helpers/fake-workbench.js';
import { readMonocerosConfig } from '../src/config/global.js';
import { parseConfig } from '../src/config/io.js';
import { setContainerGitUserInDoc } from '../src/modify/yml.js';
import {
  collectGitIdentity,
  resolveIdentityWithPrompt,
} from '../src/devcontainer/identity.js';

/**
 * Persistence flow for an identity that came from the apply / init
 * prompt: scope `g` writes monoceros-config defaults, `c` writes the
 * container yml's git.user, `b` does both. These tests pin the
 * round-trip — schema-validate the written files via the real
 * readers, not just string matches, so a typo in our setters surfaces.
 */

describe('setContainerGitUserInDoc', () => {
  it('creates git.user from scratch when neither git nor git.user exists', () => {
    const doc = parseDocument('schemaVersion: 1\nname: demo\n');
    const changed = setContainerGitUserInDoc(doc, {
      name: 'Alice',
      email: 'alice@example.com',
    });
    expect(changed).toBe(true);
    const text = String(doc);
    expect(text).toMatch(/git:\s*\n\s+user:\s*\n\s+name: Alice/);
    expect(text).toContain('email: alice@example.com');
  });

  it('updates git.user in place when it already exists', () => {
    const doc = parseDocument(
      [
        'schemaVersion: 1',
        'name: demo',
        'git:',
        '  user:',
        '    name: Old',
        '    email: old@example.com',
        '',
      ].join('\n'),
    );
    const changed = setContainerGitUserInDoc(doc, {
      name: 'New',
      email: 'new@example.com',
    });
    expect(changed).toBe(true);
    const text = String(doc);
    expect(text).toContain('name: New');
    expect(text).toContain('email: new@example.com');
    expect(text).not.toContain('Old');
  });

  it('returns false (no-op) when values are already identical', () => {
    const doc = parseDocument(
      [
        'schemaVersion: 1',
        'name: demo',
        'git:',
        '  user:',
        '    name: Alice',
        '    email: alice@example.com',
        '',
      ].join('\n'),
    );
    const changed = setContainerGitUserInDoc(doc, {
      name: 'Alice',
      email: 'alice@example.com',
    });
    expect(changed).toBe(false);
  });

  it('preserves comments elsewhere in the yml', () => {
    const doc = parseDocument(
      [
        '# top-of-file comment',
        'schemaVersion: 1',
        'name: demo',
        '# language list below',
        'languages:',
        '  - node',
        '',
      ].join('\n'),
    );
    setContainerGitUserInDoc(doc, { name: 'Alice', email: 'a@example.com' });
    const text = String(doc);
    expect(text).toContain('# top-of-file comment');
    expect(text).toContain('# language list below');
    expect(text).toMatch(/git:\s*\n\s+user:/);
  });

  it('round-trips through the real yml schema', () => {
    const doc = parseDocument('schemaVersion: 1\nname: demo\n');
    setContainerGitUserInDoc(doc, {
      name: 'Alice Example',
      email: 'alice@example.com',
    });
    const parsed = parseConfig(String(doc));
    expect(parsed.config.git?.user).toEqual({
      name: 'Alice Example',
      email: 'alice@example.com',
    });
  });
});

describe('resolveIdentityWithPrompt — scope prompt only when both keys come from prompt', () => {
  it('returns prompted=undefined when host provides both name and email', async () => {
    const result = await resolveIdentityWithPrompt({
      spawn: async (key) => ({
        value: key === 'user.name' ? 'Host Name' : 'host@example.com',
        exitCode: 0,
      }),
      prompt: async () => {
        throw new Error('prompt should not be called');
      },
      scopePrompt: async () => {
        throw new Error('scope prompt should not be called');
      },
      logger: { info: () => {}, warn: () => {} },
    });
    expect(result.name).toBe('Host Name');
    expect(result.email).toBe('host@example.com');
    expect(result.prompted).toBeUndefined();
  });

  it('triggers the scope prompt only after both keys came from the prompt', async () => {
    let scopeCalled = 0;
    const result = await resolveIdentityWithPrompt({
      spawn: async () => ({ value: '', exitCode: 1 }),
      prompt: async (key) => (key === 'user.name' ? 'Alice' : 'a@example.com'),
      scopePrompt: async () => {
        scopeCalled++;
        return 'g';
      },
      logger: { info: () => {}, warn: () => {} },
    });
    expect(scopeCalled).toBe(1);
    expect(result.prompted).toEqual({
      name: 'Alice',
      email: 'a@example.com',
      scope: 'g',
    });
  });

  // The inverse of what this file used to pin. `.monoceros/gitconfig`
  // is written by every apply, so treating it as a source made the
  // identity outlive the thing that produced it: comment the env out,
  // apply, and the container still committed under the old name. The
  // yml and the env are the source of truth, and that only holds if
  // deriving can take something away again.
  it('does not read the generated gitconfig back in as a source', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'identity-'));
    await mkdir(path.join(dir, '.monoceros'), { recursive: true });
    const file = path.join(dir, '.monoceros', 'gitconfig');
    await writeFile(
      file,
      '[user]\n\tname = From An Earlier Apply\n\temail = old@example.com\n',
    );
    const result = await collectGitIdentity(dir, {
      spawn: async () => ({ value: '', exitCode: 1 }),
      prompt: async () => undefined,
      scopePrompt: async () => undefined,
      logger: { info: () => {}, warn: () => {} },
    });
    expect(result.name).toBeUndefined();
    expect(result.email).toBeUndefined();
    // And the stale values are gone from the file, so the container
    // does not keep committing under a name nothing declares.
    const after = await readFile(file, 'utf8');
    expect(after).not.toContain('From An Earlier Apply');
    await rm(dir, { recursive: true, force: true });
  });

  it('returns prompted=undefined when the builder declines to save', async () => {
    // `n` means "use it for this apply, write it nowhere". The value is
    // still the one the builder just typed; it simply is not persisted,
    // so the question comes back next time.
    const result = await resolveIdentityWithPrompt({
      spawn: async () => ({ value: '', exitCode: 1 }),
      prompt: async (key) =>
        key === 'user.name' ? 'Typed Name' : 'typed@example.com',
      scopePrompt: async () => 'n',
      logger: { info: () => {}, warn: () => {} },
    });
    expect(result.name).toBe('Typed Name');
    expect(result.prompted).toBeUndefined();
  });

  it('skips the scope prompt when defaults already cover the identity', async () => {
    let scopeCalled = 0;
    const result = await resolveIdentityWithPrompt({
      spawn: async () => ({ value: '', exitCode: 1 }),
      prompt: async () => {
        throw new Error('prompt should not be called');
      },
      defaults: { name: 'Default Name', email: 'default@example.com' },
      scopePrompt: async () => {
        scopeCalled++;
        return 'g';
      },
      logger: { info: () => {}, warn: () => {} },
    });
    expect(scopeCalled).toBe(0);
    expect(result.prompted).toBeUndefined();
    expect(result.name).toBe('Default Name');
  });

  it('skips the scope prompt when only one key came from the prompt', async () => {
    // Host has name but no email — the email comes from the prompt.
    // The scope prompt makes no sense in this half-prompted state
    // (caller wouldn't know whether to persist just the email or
    // both fields), so we skip it.
    let scopeCalled = 0;
    const result = await resolveIdentityWithPrompt({
      spawn: async (key) =>
        key === 'user.name'
          ? { value: 'Host Name', exitCode: 0 }
          : { value: '', exitCode: 1 },
      prompt: async (key) =>
        key === 'user.email' ? 'a@example.com' : undefined,
      scopePrompt: async () => {
        scopeCalled++;
        return 'g';
      },
      logger: { info: () => {}, warn: () => {} },
    });
    expect(scopeCalled).toBe(0);
    expect(result.prompted).toBeUndefined();
    expect(result.name).toBe('Host Name');
    expect(result.email).toBe('a@example.com');
  });
});

describe('init scaffolds a ${VAR} git.user + seeds <name>.env when --with-repo', () => {
  // Integration test — init no longer prompts for identity. With repos
  // present it renders a container-level `git.user` placeholder block
  // and seeds blank GIT_USER_* keys; identity resolves at apply time.
  let home: string;
  let workbench: string;
  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'monoceros-init-id-'));
    workbench = await mkdtemp(path.join(tmpdir(), 'monoceros-init-id-wb-'));
    await mkdir(path.join(home, 'container-configs'), { recursive: true });
    await writeDescriptor(
      workbench,
      'languages',
      'node',
      nodeLanguageDescriptor(),
    );
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(workbench, { recursive: true, force: true });
  });

  it('renders a ${VAR} git.user block and seeds blank GIT_USER_* into <name>.env', async () => {
    const { runInit } = await import('../src/init/index.js');
    await runInit({
      name: 'sandbox',
      languages: ['node'],
      withRepo: ['https://github.com/foo/bar.git'],
      workbenchRoot: workbench,
      monocerosHome: home,
      logger: { success: () => {}, info: () => {} },
    });
    const ymlText = await readFile(
      path.join(home, 'container-configs', 'sandbox.yml'),
      'utf8',
    );
    const parsed = parseConfig(ymlText);
    expect(parsed.config.git?.user).toEqual({
      name: '${GIT_USER_NAME}',
      email: '${GIT_USER_EMAIL}',
    });
    const envText = await readFile(
      path.join(home, 'container-configs', 'sandbox.env'),
      'utf8',
    );
    expect(envText).toMatch(/^GIT_USER_NAME=$/m);
    expect(envText).toMatch(/^GIT_USER_EMAIL=$/m);
    // No monoceros-config written — identity is env/cascade-resolved.
    const globalConfig = await readMonocerosConfig({ monocerosHome: home });
    expect(globalConfig).toBeUndefined();
  });

  it('renders no git block and seeds no GIT_USER_* when there are no repos', async () => {
    const { runInit } = await import('../src/init/index.js');
    await runInit({
      name: 'sandbox',
      languages: ['node'],
      workbenchRoot: workbench,
      monocerosHome: home,
      logger: { success: () => {}, info: () => {} },
    });
    const ymlText = await readFile(
      path.join(home, 'container-configs', 'sandbox.yml'),
      'utf8',
    );
    expect(ymlText).not.toMatch(/^git:/m);
    const envText = await readFile(
      path.join(home, 'container-configs', 'sandbox.env'),
      'utf8',
    );
    expect(envText).not.toContain('GIT_USER_NAME');
  });
});
