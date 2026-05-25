import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';
import {
  readMonocerosConfig,
  writeGlobalDefaultGitUser,
} from '../src/config/global.js';
import { parseConfig } from '../src/config/io.js';
import { setContainerGitUserInDoc } from '../src/modify/yml.js';
import { resolveIdentityWithPrompt } from '../src/devcontainer/identity.js';

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

describe('writeGlobalDefaultGitUser', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'monoceros-global-write-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('creates monoceros-config.yml from scratch when none exists', async () => {
    const result = await writeGlobalDefaultGitUser(
      { name: 'Alice', email: 'a@example.com' },
      { monocerosHome: home },
    );
    expect(result.created).toBe(true);
    expect(result.alreadySet).toBe(false);
    // Verify via the real reader, not a string match — catches schema
    // typos in the freshly-written file.
    const parsed = await readMonocerosConfig({ monocerosHome: home });
    expect(parsed?.defaults?.git?.user).toEqual({
      name: 'Alice',
      email: 'a@example.com',
    });
  });

  it('fills in defaults.git.user when the file exists but the user is unset', async () => {
    // Common case: builder created monoceros-config for feature defaults
    // and then later runs apply for the first time → identity prompt.
    await writeFile(
      path.join(home, 'monoceros-config.yml'),
      [
        'schemaVersion: 1',
        'defaults:',
        '  features:',
        '    ghcr.io/getmonoceros/monoceros-features/claude-code:1:',
        '      apiKey: sk-existing',
        '',
      ].join('\n'),
    );
    const result = await writeGlobalDefaultGitUser(
      { name: 'Alice', email: 'a@example.com' },
      { monocerosHome: home },
    );
    expect(result.created).toBe(false);
    expect(result.alreadySet).toBe(false);
    const parsed = await readMonocerosConfig({ monocerosHome: home });
    expect(parsed?.defaults?.git?.user).toEqual({
      name: 'Alice',
      email: 'a@example.com',
    });
    // The unrelated features default must survive the AST edit.
    expect(
      parsed?.defaults?.features?.[
        'ghcr.io/getmonoceros/monoceros-features/claude-code:1'
      ]?.apiKey,
    ).toBe('sk-existing');
  });

  it('does NOT clobber an existing defaults.git.user — reports alreadySet', async () => {
    await writeFile(
      path.join(home, 'monoceros-config.yml'),
      [
        'schemaVersion: 1',
        'defaults:',
        '  git:',
        '    user:',
        '      name: Existing',
        '      email: existing@example.com',
        '',
      ].join('\n'),
    );
    const result = await writeGlobalDefaultGitUser(
      { name: 'New', email: 'new@example.com' },
      { monocerosHome: home },
    );
    expect(result.alreadySet).toBe(true);
    const parsed = await readMonocerosConfig({ monocerosHome: home });
    expect(parsed?.defaults?.git?.user).toEqual({
      name: 'Existing',
      email: 'existing@example.com',
    });
  });

  it('preserves the full shipped-sample structure when injecting git.user (no comment chaos)', async () => {
    // Regression for the bug where the yaml-AST setter rearranged the
    // shipped sample's comments (section dividers between sub-blocks
    // attached to the wrong node, so the inserted git block landed
    // mid-features with comments dangling around it). The new
    // string-based insert must keep every comment byte-for-byte in
    // its original position.
    const sampleText = [
      '# Monoceros — builder-global config.',
      '',
      'schemaVersion: 1',
      '',
      '# ── defaults section ─────────────────',
      'defaults:',
      '  # Git committer identity ...',
      '  # git:',
      '  #   user:',
      '  #     name: Your Name',
      '  #     email: you@example.com',
      '',
      '  # Per-feature option defaults ...',
      '  features:',
      '    ghcr.io/getmonoceros/monoceros-features/claude-code:1:',
      '      apiKey: sk-live-value',
      '',
      '# ── routing section ─────────────────',
      'routing:',
      '  hostPort: 80',
      '',
    ].join('\n');
    await writeFile(path.join(home, 'monoceros-config.yml'), sampleText);
    await writeGlobalDefaultGitUser(
      { name: 'Alice', email: 'a@example.com' },
      { monocerosHome: home },
    );
    const after = await readFile(
      path.join(home, 'monoceros-config.yml'),
      'utf8',
    );
    // Every line of the original sample (header, section dividers,
    // commented git block, features block, routing block) must
    // still be present, unchanged, in order.
    for (const line of sampleText.split('\n')) {
      if (line.length === 0) continue;
      expect(after).toContain(line);
    }
    // The routing section divider must come AFTER the features
    // section divider — i.e. the section ordering survives the
    // insert.
    const featuresDividerAt = after.indexOf('# ── defaults section');
    const routingDividerAt = after.indexOf('# ── routing section');
    expect(featuresDividerAt).toBeGreaterThanOrEqual(0);
    expect(routingDividerAt).toBeGreaterThan(featuresDividerAt);
    // And of course the active block parses into the right shape.
    const parsed = await readMonocerosConfig({ monocerosHome: home });
    expect(parsed?.defaults?.git?.user).toEqual({
      name: 'Alice',
      email: 'a@example.com',
    });
    expect(
      parsed?.defaults?.features?.[
        'ghcr.io/getmonoceros/monoceros-features/claude-code:1'
      ]?.apiKey,
    ).toBe('sk-live-value');
    expect(parsed?.routing?.hostPort).toBe(80);
  });

  it('handles the shipped-sample "defaults: null" shape', async () => {
    // The shipped sample has `defaults:` uncommented with every
    // sub-block commented out — that parses as `defaults: null`. The
    // writer has to recover by replacing null with an empty map and
    // setting git.user under it.
    await writeFile(
      path.join(home, 'monoceros-config.yml'),
      [
        'schemaVersion: 1',
        'defaults:',
        '  # everything below is commented out',
        '',
      ].join('\n'),
    );
    const result = await writeGlobalDefaultGitUser(
      { name: 'Alice', email: 'a@example.com' },
      { monocerosHome: home },
    );
    expect(result.alreadySet).toBe(false);
    const parsed = await readMonocerosConfig({ monocerosHome: home });
    expect(parsed?.defaults?.git?.user?.name).toBe('Alice');
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

  it('triggers the scope prompt when both keys come from .monoceros/gitconfig and no defaults are set', async () => {
    // Regression for the case the builder hit: monoceros-config
    // identity removed, but `.monoceros/gitconfig` still carries the
    // values from an earlier apply. Without this prompt, apply would
    // silently use the persisted values and never re-offer to write
    // them to monoceros-config.
    let scopeCtx: { reason: string; name: string; email: string } | undefined;
    const result = await resolveIdentityWithPrompt({
      spawn: async () => ({ value: '', exitCode: 1 }),
      prompt: async () => {
        throw new Error('prompt should not be called — persisted has values');
      },
      persistedValues: {
        name: 'Persisted Name',
        email: 'persisted@example.com',
      },
      scopePrompt: async (ctx) => {
        scopeCtx = ctx;
        return 'g';
      },
      logger: { info: () => {}, warn: () => {} },
    });
    expect(scopeCtx?.reason).toBe('persisted');
    expect(scopeCtx?.name).toBe('Persisted Name');
    expect(result.prompted?.scope).toBe('g');
  });

  it('returns prompted=undefined when the builder picks `n` (keep as-is)', async () => {
    // `n` is the "skip persistence" option — the values are valid
    // for this apply (via .monoceros/gitconfig), but the builder
    // explicitly chose not to write them anywhere new. Result.prompted
    // stays undefined so the caller doesn't try to persist.
    const result = await resolveIdentityWithPrompt({
      spawn: async () => ({ value: '', exitCode: 1 }),
      prompt: async () => undefined,
      persistedValues: {
        name: 'Persisted',
        email: 'persisted@example.com',
      },
      scopePrompt: async () => 'n',
      logger: { info: () => {}, warn: () => {} },
    });
    expect(result.name).toBe('Persisted');
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

describe('init persists prompted identity to monoceros-config when --with-repo', () => {
  // Integration test — init + identity prompt + write to globalconfig.
  // Skips writing .monoceros/gitconfig (no devContainerRoot exists at
  // init time); just exercises the prompt → persistence path.
  let home: string;
  let workbench: string;
  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'monoceros-init-id-'));
    workbench = await mkdtemp(path.join(tmpdir(), 'monoceros-init-id-wb-'));
    await mkdir(path.join(home, 'container-configs'), { recursive: true });
    const compRoot = path.join(workbench, 'templates', 'components');
    await mkdir(compRoot, { recursive: true });
    await writeFile(
      path.join(compRoot, 'node.yml'),
      [
        'displayName: Node.js',
        'description: Node 22',
        'category: language',
        'contributes:',
        '  languages:',
        '    - node',
        '',
      ].join('\n'),
    );
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(workbench, { recursive: true, force: true });
  });

  it('writes defaults.git.user to monoceros-config when scope=g', async () => {
    const { runInit } = await import('../src/init/index.js');
    await runInit({
      name: 'sandbox',
      with: ['node'],
      withRepo: ['https://github.com/foo/bar.git'],
      workbenchRoot: workbench,
      monocerosHome: home,
      identitySpawn: async () => ({ value: '', exitCode: 1 }),
      identityPrompt: async (key) =>
        key === 'user.name' ? 'Alice' : 'a@example.com',
      identityScopePrompt: async () => 'g',
      logger: { success: () => {}, info: () => {} },
    });
    const parsed = await readMonocerosConfig({ monocerosHome: home });
    expect(parsed?.defaults?.git?.user).toEqual({
      name: 'Alice',
      email: 'a@example.com',
    });
    // Container yml does NOT receive a git.user override under scope=g.
    const ymlText = await readFile(
      path.join(home, 'container-configs', 'sandbox.yml'),
      'utf8',
    );
    expect(ymlText).not.toMatch(/^git:/m);
  });

  it('writes container-level git.user when scope=c', async () => {
    const { runInit } = await import('../src/init/index.js');
    await runInit({
      name: 'sandbox',
      with: ['node'],
      withRepo: ['https://github.com/foo/bar.git'],
      workbenchRoot: workbench,
      monocerosHome: home,
      identitySpawn: async () => ({ value: '', exitCode: 1 }),
      identityPrompt: async (key) =>
        key === 'user.name' ? 'Bob' : 'bob@example.com',
      identityScopePrompt: async () => 'c',
      logger: { success: () => {}, info: () => {} },
    });
    const parsed = parseConfig(
      await readFile(
        path.join(home, 'container-configs', 'sandbox.yml'),
        'utf8',
      ),
    );
    expect(parsed.config.git?.user).toEqual({
      name: 'Bob',
      email: 'bob@example.com',
    });
    // monoceros-config NOT created under scope=c.
    const globalConfig = await readMonocerosConfig({ monocerosHome: home });
    expect(globalConfig).toBeUndefined();
  });

  it('writes both under scope=b', async () => {
    const { runInit } = await import('../src/init/index.js');
    await runInit({
      name: 'sandbox',
      with: ['node'],
      withRepo: ['https://github.com/foo/bar.git'],
      workbenchRoot: workbench,
      monocerosHome: home,
      identitySpawn: async () => ({ value: '', exitCode: 1 }),
      identityPrompt: async (key) =>
        key === 'user.name' ? 'Carol' : 'c@example.com',
      identityScopePrompt: async () => 'b',
      logger: { success: () => {}, info: () => {} },
    });
    const globalConfig = await readMonocerosConfig({ monocerosHome: home });
    expect(globalConfig?.defaults?.git?.user?.name).toBe('Carol');
    const parsed = parseConfig(
      await readFile(
        path.join(home, 'container-configs', 'sandbox.yml'),
        'utf8',
      ),
    );
    expect(parsed.config.git?.user?.name).toBe('Carol');
  });

  it('skips the prompt entirely when --with-repo is not used', async () => {
    const { runInit } = await import('../src/init/index.js');
    let promptCalled = 0;
    await runInit({
      name: 'sandbox',
      with: ['node'],
      workbenchRoot: workbench,
      monocerosHome: home,
      identitySpawn: async () => ({ value: '', exitCode: 1 }),
      identityPrompt: async () => {
        promptCalled++;
        return 'should-not-be-called';
      },
      identityScopePrompt: async () => 'g',
      logger: { success: () => {}, info: () => {} },
    });
    expect(promptCalled).toBe(0);
  });
});
