import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runRemove } from '../src/remove/index.js';
import { runRestore } from '../src/restore/index.js';

const silentLogger = {
  info: () => {},
  success: () => {},
  warn: () => {},
};

const stubDocker = (): ((
  args: string[],
) => Promise<{ exitCode: number; stdout: string; stderr: string }>) => {
  return () => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
};

describe('runRestore', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'monoceros-restore-'));
    await mkdir(path.join(home, 'container-configs'), { recursive: true });
    await mkdir(path.join(home, 'container'), { recursive: true });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  async function seedAndRemove(
    name: string,
  ): Promise<{ backupPath: string; credentialsContent: string }> {
    const ymlPath = path.join(home, 'container-configs', `${name}.yml`);
    await writeFile(ymlPath, `schemaVersion: 1\nname: ${name}\n`);
    const dir = path.join(home, 'container', name);
    await mkdir(path.join(dir, 'home', '.claude'), { recursive: true });
    const credentials = `{"token":"masked-for-${name}"}`;
    await writeFile(
      path.join(dir, 'home', '.claude', '.credentials.json'),
      credentials,
    );
    await mkdir(path.join(dir, 'data', 'postgres'), { recursive: true });
    await writeFile(path.join(dir, 'data', 'postgres', 'rows.dat'), 'data');

    const result = await runRemove({
      name,
      monocerosHome: home,
      dockerExec: stubDocker(),
      logger: silentLogger,
      now: new Date('2026-07-04T08:00:00Z'),
    });
    return {
      backupPath: result.backupPath!,
      credentialsContent: credentials,
    };
  }

  it('restores yml + container dir verbatim from a backup', async () => {
    const { backupPath, credentialsContent } = await seedAndRemove('sandbox');

    // host state is gone after remove
    expect(
      (await readdir(path.join(home, 'container-configs'))).includes(
        'sandbox.yml',
      ),
    ).toBe(false);

    const result = await runRestore({
      backupPath,
      monocerosHome: home,
      logger: silentLogger,
    });

    expect(result.name).toBe('sandbox');
    expect(result.configPath).toBe(
      path.join(home, 'container-configs', 'sandbox.yml'),
    );
    expect(result.containerPath).toBe(path.join(home, 'container', 'sandbox'));

    // yml is back
    const ymlContent = await readFile(result.configPath, 'utf8');
    expect(ymlContent).toContain('name: sandbox');

    // home state survived
    const creds = await readFile(
      path.join(result.containerPath!, 'home', '.claude', '.credentials.json'),
      'utf8',
    );
    expect(creds).toBe(credentialsContent);

    // DB data survived
    const dat = await readFile(
      path.join(result.containerPath!, 'data', 'postgres', 'rows.dat'),
      'utf8',
    );
    expect(dat).toBe('data');
  });

  it('refuses to clobber an existing container-configs yml', async () => {
    const { backupPath } = await seedAndRemove('sandbox');
    // Build a half-state: yml exists, container dir does not.
    await writeFile(
      path.join(home, 'container-configs', 'sandbox.yml'),
      'schemaVersion: 1\nname: sandbox\n# already there\n',
    );

    await expect(
      runRestore({
        backupPath,
        monocerosHome: home,
        logger: silentLogger,
      }),
    ).rejects.toThrow(/already exists.*Remove the current container first/);
  });

  it('refuses to clobber an existing container directory', async () => {
    const { backupPath } = await seedAndRemove('sandbox');
    await mkdir(path.join(home, 'container', 'sandbox'), { recursive: true });

    await expect(
      runRestore({
        backupPath,
        monocerosHome: home,
        logger: silentLogger,
      }),
    ).rejects.toThrow(/already exists/);
  });

  it('errors when the backup path is missing or not a directory', async () => {
    await expect(
      runRestore({
        backupPath: path.join(home, 'does', 'not', 'exist'),
        monocerosHome: home,
        logger: silentLogger,
      }),
    ).rejects.toThrow(/Backup not found/);

    const file = path.join(home, 'just-a-file');
    await writeFile(file, 'data');
    await expect(
      runRestore({
        backupPath: file,
        monocerosHome: home,
        logger: silentLogger,
      }),
    ).rejects.toThrow(/not a directory/);
  });

  it('errors when the backup has no yml at the root', async () => {
    const bogus = await mkdtemp(path.join(tmpdir(), 'monoceros-bogus-bk-'));
    try {
      await mkdir(path.join(bogus, 'container'), { recursive: true });
      await expect(
        runRestore({
          backupPath: bogus,
          monocerosHome: home,
          logger: silentLogger,
        }),
      ).rejects.toThrow(/doesn't contain a \*\.yml/);
    } finally {
      await rm(bogus, { recursive: true, force: true });
    }
  });

  it('handles a backup that only carries the yml (no container dir)', async () => {
    // Simulate: a remove that ran when apply had never produced a
    // container directory in the first place.
    const bk = await mkdtemp(path.join(tmpdir(), 'monoceros-onlyyml-bk-'));
    try {
      await writeFile(
        path.join(bk, 'half.yml'),
        'schemaVersion: 1\nname: half\n',
      );
      const result = await runRestore({
        backupPath: bk,
        monocerosHome: home,
        logger: silentLogger,
      });
      expect(result.name).toBe('half');
      expect(result.containerPath).toBeNull();
      expect(
        (await readdir(path.join(home, 'container-configs'))).includes(
          'half.yml',
        ),
      ).toBe(true);
    } finally {
      await rm(bk, { recursive: true, force: true });
    }
  });
});
