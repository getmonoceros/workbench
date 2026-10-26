import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  publicRemoteUrl,
  readTemplateRepository,
  templateSource,
} from '../src/catalog/template-repository.js';

function git(cwd: string, ...args: string[]): void {
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'init.defaultBranch=main',
      ...args,
    ],
    { cwd, stdio: 'ignore' },
  );
}

async function put(dir: string, file: string, text = 'x\n'): Promise<string> {
  const p = path.join(dir, file);
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, text);
  return p;
}

/**
 * Which of the builder's template files a colleague has too (#146): the ones
 * committed in the team repository the templates folder is a clone of.
 */
describe('readTemplateRepository', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'monoceros-template-repo-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('finds no repository in a plain folder', async () => {
    const dir = path.join(root, 'templates');
    const file = await put(dir, 'services/rabbitmq.yml');
    const repo = readTemplateRepository(dir);
    expect(repo).toBeUndefined();
    expect(templateSource(file, repo)).toBe('personal');
  });

  it('tells committed files from ignored and uncommitted ones', async () => {
    const dir = path.join(root, 'templates');
    await mkdir(dir);
    git(dir, 'init');
    await put(dir, '.gitignore', 'workbenches/my-*.yml\n');
    const team = await put(dir, 'workbenches/team-node.yml');
    const service = await put(dir, 'services/rabbitmq.yml');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-m', 'team files');
    const ignored = await put(dir, 'workbenches/my-only-node.yml');
    const pending = await put(dir, 'services/gotenberg.yml');

    const repo = readTemplateRepository(dir);
    expect(templateSource(team, repo)).toBe('team');
    expect(templateSource(service, repo)).toBe('team');
    expect(templateSource(ignored, repo)).toBe('personal');
    expect(templateSource(pending, repo)).toBe('personal');
    expect(repo).not.toHaveProperty('url');
  });

  it('shares nothing before the first commit', async () => {
    const dir = path.join(root, 'templates');
    await mkdir(dir);
    git(dir, 'init');
    const file = await put(dir, 'services/rabbitmq.yml');
    git(dir, 'add', '-A');
    const repo = readTemplateRepository(dir);
    expect(repo).toBeDefined();
    expect(templateSource(file, repo)).toBe('personal');
  });

  /**
   * The dev home `.local/templates/` sits inside the workbench checkout. Its
   * files are not the team's, and the checkout's remote is not a template
   * repository.
   */
  it('ignores a repository the folder only sits inside', async () => {
    git(root, 'init');
    git(root, 'remote', 'add', 'origin', 'https://github.com/acme/app.git');
    const dir = path.join(root, '.local', 'templates');
    const file = await put(dir, 'services/rabbitmq.yml');
    git(root, 'add', '-A');
    git(root, 'commit', '-m', 'everything');
    const repo = readTemplateRepository(dir);
    expect(repo).toBeUndefined();
    expect(templateSource(file, repo)).toBe('personal');
  });

  it('names the remote without the token in it', async () => {
    const dir = path.join(root, 'templates');
    await mkdir(dir);
    git(dir, 'init');
    git(
      dir,
      'remote',
      'add',
      'origin',
      'https://ghp_secret@github.com/acme/monoceros-templates.git',
    );
    expect(readTemplateRepository(dir)?.url).toBe(
      'https://github.com/acme/monoceros-templates.git',
    );
  });
});

describe('publicRemoteUrl', () => {
  it('drops user and password from an HTTPS URL', () => {
    expect(
      publicRemoteUrl('https://x-access-token:abc@gitlab.example.com/t/r.git'),
    ).toBe('https://gitlab.example.com/t/r.git');
    expect(publicRemoteUrl('https://github.com/acme/templates.git')).toBe(
      'https://github.com/acme/templates.git',
    );
  });

  it('leaves out anything that is not HTTP(S)', () => {
    expect(
      publicRemoteUrl('git@github.com:acme/templates.git'),
    ).toBeUndefined();
    expect(
      publicRemoteUrl('ssh://git@github.com/acme/templates.git'),
    ).toBeUndefined();
    expect(publicRemoteUrl('')).toBeUndefined();
  });
});
