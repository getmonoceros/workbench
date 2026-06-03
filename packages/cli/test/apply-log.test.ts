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
import { runApply } from '../src/apply/index.js';
import { createApplyLog } from '../src/apply/apply-log.js';
import { containerLogsDir } from '../src/config/paths.js';

const silentLogger = {
  info: () => {},
  success: () => {},
  warn: () => {},
};

const stubDockerExec = async () => ({ exitCode: 0, stdout: '', stderr: '' });
const stubIdentitySpawn = async () => ({ value: '', exitCode: 1 });
const stubIdentityPrompt = async () => undefined;
const stubCredentialsSpawn = async (input: string) => {
  const host = /host=([^\n]+)/.exec(input)?.[1] ?? 'unknown';
  return {
    stdout: `protocol=https\nhost=${host}\nusername=ci\npassword=tok-${host}\n`,
    exitCode: 0,
  };
};
const stubDockerInfoSpawn = async () => ({
  stdout: '["name=seccomp,profile=builtin"]',
  exitCode: 0,
});

// Spawn fake that mirrors the real masked-stream behaviour by writing
// a representative devcontainer-cli transcript into `options.logSink`
// before resolving. Lets us assert that runApply teed the stream
// correctly without spinning up a real container.
const recordingDevcontainerSpawn = (
  transcript: string,
): ((
  args: string[],
  cwd: string,
  options?: { logSink?: NodeJS.WritableStream },
) => Promise<number>) => {
  return async (_args, _cwd, options) => {
    options?.logSink?.write(transcript);
    return 0;
  };
};

const baseRunOpts = {
  cliVersion: '9.9.9',
  logger: silentLogger,
  dockerExec: stubDockerExec,
  identitySpawn: stubIdentitySpawn,
  identityPrompt: stubIdentityPrompt,
  credentialsSpawn: stubCredentialsSpawn,
  dockerInfoSpawn: stubDockerInfoSpawn,
};

describe('apply log file', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'monoceros-apply-log-'));
    await mkdir(path.join(home, 'container-configs'), { recursive: true });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  async function writeYml(name: string, body: string): Promise<void> {
    await writeFile(path.join(home, 'container-configs', `${name}.yml`), body);
  }

  it('writes <container>/logs/apply-<name>-<iso>.log with a header', async () => {
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    const now = new Date('2026-06-03T17:15:21.123Z');

    await runApply({
      ...baseRunOpts,
      name: 'demo',
      monocerosHome: home,
      now,
      devcontainerSpawn: recordingDevcontainerSpawn(''),
    });

    const logsDir = containerLogsDir('demo', home);
    const files = await readdir(logsDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^apply-demo-2026-06-03T17-15-21-123Z\.log$/);

    const contents = await readFile(path.join(logsDir, files[0]!), 'utf8');
    expect(contents).toContain('# monoceros apply log');
    expect(contents).toContain('# command:     monoceros apply demo');
    expect(contents).toContain('# started:     2026-06-03T17:15:21.123Z');
    expect(contents).toContain('# cli-version: 9.9.9');
    expect(contents).toContain(
      `# config:      ${path.join(home, 'container-configs', 'demo.yml')}`,
    );
  });

  it('captures the features line, the pull warning, and the devcontainer-cli stream', async () => {
    await writeYml(
      'streamy',
      [
        'schemaVersion: 1',
        'name: streamy',
        'features:',
        '  - ref: ghcr.io/devcontainers/features/node:1',
        '',
      ].join('\n'),
    );

    const transcript =
      '[2026-06-03T17:15:21.280Z] @devcontainers/cli 0.86.1.\n' +
      '[2026-06-03T17:15:21.431Z] Start: Run: docker run …\n' +
      '[2026-06-03T17:15:21.563Z] Container started\n';

    await runApply({
      ...baseRunOpts,
      name: 'streamy',
      monocerosHome: home,
      devcontainerSpawn: recordingDevcontainerSpawn(transcript),
    });

    const logsDir = containerLogsDir('streamy', home);
    const [file] = await readdir(logsDir);
    const contents = await readFile(path.join(logsDir, file!), 'utf8');

    // Our own info lines: prefixed with [info] by the tee logger.
    expect(contents).toContain(
      '[info] Features: ghcr.io/devcontainers/features/node:1',
    );
    expect(contents).toMatch(
      /\[info\] Pulling runtime image and building feature layers/,
    );

    // devcontainer-cli stream lines: written raw via logSink.
    expect(contents).toContain('Start: Run: docker run');
    expect(contents).toContain('Container started');
  });

  it('strips ANSI escapes from the mirrored logger output', async () => {
    await writeYml('ansi', 'schemaVersion: 1\nname: ansi\n');

    await runApply({
      ...baseRunOpts,
      name: 'ansi',
      monocerosHome: home,
      devcontainerSpawn: recordingDevcontainerSpawn(''),
    });

    const logsDir = containerLogsDir('ansi', home);
    const [file] = await readdir(logsDir);
    const contents = await readFile(path.join(logsDir, file!), 'utf8');

    // Even when the wrapped logger emits ANSI (e.g. `dim()` on the
    // pull warning when stderr is a TTY), the log file must stay
    // plain text — otherwise `cat ~/.monoceros/.../apply-….log`
    // shows escape sequences instead of readable text.
    // eslint-disable-next-line no-control-regex
    expect(contents).not.toMatch(/\x1b\[/);
  });
});

describe('createApplyLog', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'monoceros-create-log-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('creates the logs/ directory on demand', async () => {
    const log = createApplyLog({
      name: 'fresh',
      home,
      cliVersion: '0.0.0',
      configPath: '/tmp/fresh.yml',
      now: new Date('2026-06-03T00:00:00.000Z'),
    });
    await log.close();

    const files = await readdir(containerLogsDir('fresh', home));
    expect(files).toEqual(['apply-fresh-2026-06-03T00-00-00-000Z.log']);
  });

  it('close() is idempotent', async () => {
    const log = createApplyLog({
      name: 'idem',
      home,
      cliVersion: '0.0.0',
      configPath: '/tmp/idem.yml',
      now: new Date('2026-06-03T00:00:00.000Z'),
    });
    await log.close();
    await log.close();
  });
});
