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

  // apply requires a pinned runtimeVersion (ADR 0017); inject one after
  // `schemaVersion: 1` unless the body already sets it.
  async function writeYml(name: string, body: string): Promise<void> {
    const pinned = body.includes('runtimeVersion:')
      ? body
      : body.replace(
          /^schemaVersion: 1$/m,
          'schemaVersion: 1\nruntimeVersion: 1.1.0',
        );
    await writeFile(
      path.join(home, 'container-configs', `${name}.yml`),
      pinned,
    );
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

  it('captures the pull warning, the devcontainer-cli stream, and the summary block', async () => {
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

    // Pull warning is now log-only (was screen-only before step 2).
    expect(contents).toMatch(
      /\[info\] Pulling runtime image and building feature layers/,
    );

    // devcontainer-cli stream lines: written raw via logSink.
    expect(contents).toContain('Start: Run: docker run');
    expect(contents).toContain('Container started');

    // Summary block on success: short feature name, no full ref.
    expect(contents).toMatch(/Features\s+node/);
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

describe('runApply spinner integration', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'monoceros-spinner-'));
    await mkdir(path.join(home, 'container-configs'), { recursive: true });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  function makeProgressOut(): {
    stream: NodeJS.WriteStream;
    written: () => string;
  } {
    const chunks: string[] = [];
    const stream = {
      write: (c: unknown): boolean => {
        chunks.push(typeof c === 'string' ? c : String(c));
        return true;
      },
      isTTY: true,
    } as unknown as NodeJS.WriteStream;
    return { stream, written: () => chunks.join('') };
  }

  it('engages the spinner: pull warning lands in the log, ✔ ends the section', async () => {
    await writeFile(
      path.join(home, 'container-configs', 'spin.yml'),
      'schemaVersion: 1\nruntimeVersion: 1.1.0\nname: spin\n',
    );
    const out = makeProgressOut();

    await runApply({
      ...baseRunOpts,
      name: 'spin',
      monocerosHome: home,
      progressOut: out.stream,
      devcontainerSpawn: recordingDevcontainerSpawn(''),
    });

    const screen = out.written();
    // Spinner success line is on screen.
    expect(screen).toContain('✔ container ready');
    // Pull warning is NOT echoed to screen in spinner mode.
    expect(screen).not.toContain('First apply takes');

    // …but the warning IS in the log file.
    const logsDir = containerLogsDir('spin', home);
    const [file] = await readdir(logsDir);
    const contents = await readFile(path.join(logsDir, file!), 'utf8');
    expect(contents).toContain('# note: Pulling runtime image');
  });

  it('on failure prints ✘ + tail and the log path', async () => {
    await writeFile(
      path.join(home, 'container-configs', 'boom.yml'),
      'schemaVersion: 1\nruntimeVersion: 1.1.0\nname: boom\n',
    );
    const out = makeProgressOut();

    // Spawn fake that emits a transcript via progressSink, then exits non-zero.
    const failingSpawn = async (
      _args: string[],
      _cwd: string,
      options?: {
        logSink?: NodeJS.WritableStream;
        progressSink?: NodeJS.WritableStream;
      },
    ): Promise<number> => {
      const transcript =
        '[t1] Start: Run: docker run x\n' +
        '[t2] postCreate failed: ELIFECYCLE 1\n' +
        '[t3] npm ERR! exited with 1\n';
      options?.logSink?.write(transcript);
      options?.progressSink?.write(transcript);
      return 1;
    };

    const result = await runApply({
      ...baseRunOpts,
      name: 'boom',
      monocerosHome: home,
      progressOut: out.stream,
      devcontainerSpawn: failingSpawn,
    });
    expect(result.containerExitCode).toBe(1);

    const screen = out.written();
    expect(screen).toContain('✘ apply failed (exit 1)');
    expect(screen).toContain('postCreate failed: ELIFECYCLE 1');
    expect(screen).toContain('npm ERR! exited with 1');
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
