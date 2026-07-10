import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  defaultTargets,
  listApps,
  readLaunchConfig,
  resolveTarget,
  type LaunchConfig,
} from '../src/config/launch-config.js';

let home: string;

async function writeLaunch(
  name: string,
  appRel: string,
  body: unknown,
): Promise<void> {
  const dir = path.join(
    home,
    'container',
    name,
    'projects',
    appRel,
    '.monoceros',
  );
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'launch.json'), JSON.stringify(body));
}

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'monoceros-launch-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('readLaunchConfig', () => {
  it('returns undefined when no launch config exists', async () => {
    expect(await readLaunchConfig('acme', 'web', home)).toBeUndefined();
  });

  it('parses a valid config and keeps optional fields', async () => {
    await writeLaunch('acme', 'web', {
      version: 1,
      configurations: [
        {
          name: 'web',
          command: 'npm run dev',
          port: 3000,
          env: { NODE_ENV: 'development' },
          default: true,
        },
        { name: 'worker', command: 'npm run worker' },
      ],
    });
    const cfg = await readLaunchConfig('acme', 'web', home);
    expect(cfg?.configurations).toHaveLength(2);
    expect(cfg?.configurations[0]).toMatchObject({
      name: 'web',
      command: 'npm run dev',
      port: 3000,
      default: true,
    });
  });

  it('accepts the canonical "targets" key (alias of "configurations")', async () => {
    await writeLaunch('acme', 'web', {
      version: 1,
      targets: [{ name: 'web', command: 'npm run dev', port: 3000 }],
    });
    const cfg = await readLaunchConfig('acme', 'web', home);
    expect(cfg?.configurations).toHaveLength(1);
    expect(cfg?.configurations[0]).toMatchObject({ name: 'web', port: 3000 });
  });

  it('errors naming "targets" when neither key is present', async () => {
    await writeLaunch('acme', 'web', { version: 1 });
    await expect(readLaunchConfig('acme', 'web', home)).rejects.toThrow(
      /missing "targets" array/,
    );
  });

  it('rejects duplicate target names', async () => {
    await writeLaunch('acme', 'web', {
      configurations: [
        { name: 'web', command: 'a' },
        { name: 'web', command: 'b' },
      ],
    });
    await expect(readLaunchConfig('acme', 'web', home)).rejects.toThrow(
      /duplicate target name/,
    );
  });

  it('allows multiple defaults (a start set)', async () => {
    await writeLaunch('acme', 'web', {
      configurations: [
        { name: 'api', command: 'a', default: true },
        { name: 'web', command: 'b', default: true },
      ],
    });
    const cfg = await readLaunchConfig('acme', 'web', home);
    expect(cfg?.configurations.filter((t) => t.default)).toHaveLength(2);
  });

  it('rejects a target missing its command', async () => {
    await writeLaunch('acme', 'web', {
      configurations: [{ name: 'web' }],
    });
    await expect(readLaunchConfig('acme', 'web', home)).rejects.toThrow(
      /missing "command"/,
    );
  });
});

describe('resolveTarget', () => {
  const cfg: LaunchConfig = {
    version: 1,
    configurations: [
      { name: 'web', command: 'a', default: true },
      { name: 'worker', command: 'b' },
    ],
  };

  it('returns the named target', () => {
    expect(resolveTarget(cfg, 'worker', 'web').name).toBe('worker');
  });

  it('throws for an unknown target name', () => {
    expect(() => resolveTarget(cfg, 'nope', 'web')).toThrow(
      /no target "nope"/i,
    );
  });

  it('falls back to the default when no name is given', () => {
    expect(resolveTarget(cfg, undefined, 'web').name).toBe('web');
  });

  it('uses the sole target when there is no default', () => {
    const single: LaunchConfig = {
      version: 1,
      configurations: [{ name: 'only', command: 'a' }],
    };
    expect(resolveTarget(single, undefined, 'app').name).toBe('only');
  });

  it('throws when ambiguous and no default', () => {
    const ambiguous: LaunchConfig = {
      version: 1,
      configurations: [
        { name: 'a', command: 'a' },
        { name: 'b', command: 'b' },
      ],
    };
    expect(() => resolveTarget(ambiguous, undefined, 'app')).toThrow(
      /no default/,
    );
  });

  it('throws on a multi-target default set (single-target callers must pick)', () => {
    const multi: LaunchConfig = {
      version: 1,
      configurations: [
        { name: 'api', command: 'a', default: true },
        { name: 'web', command: 'b', default: true },
      ],
    };
    expect(() => resolveTarget(multi, undefined, 'app')).toThrow(
      /multiple default/,
    );
  });
});

describe('defaultTargets', () => {
  it('returns the marked defaults in declared order', () => {
    const cfg: LaunchConfig = {
      version: 1,
      configurations: [
        { name: 'api', command: 'a', default: true },
        { name: 'docs', command: 'd' },
        { name: 'web', command: 'b', default: true },
      ],
    };
    expect(defaultTargets(cfg).map((t) => t.name)).toEqual(['api', 'web']);
  });

  it('falls back to the sole target when none is marked', () => {
    const cfg: LaunchConfig = {
      version: 1,
      configurations: [{ name: 'only', command: 'a' }],
    };
    expect(defaultTargets(cfg).map((t) => t.name)).toEqual(['only']);
  });

  it('is empty when multiple targets and none marked', () => {
    const cfg: LaunchConfig = {
      version: 1,
      configurations: [
        { name: 'a', command: 'a' },
        { name: 'b', command: 'b' },
      ],
    };
    expect(defaultTargets(cfg)).toEqual([]);
  });
});

describe('listApps', () => {
  it('finds apps with a launch config, including nested paths, sorted', async () => {
    await writeLaunch('acme', 'web', {
      configurations: [{ name: 'w', command: 'a' }],
    });
    await writeLaunch('acme', 'apps/api', {
      configurations: [{ name: 'a', command: 'b' }],
    });
    // A project dir without a launch config is not an app.
    await mkdir(path.join(home, 'container', 'acme', 'projects', 'docs'), {
      recursive: true,
    });
    expect(await listApps('acme', home)).toEqual(['apps/api', 'web']);
  });

  it('returns empty when nothing declares a launch config', async () => {
    await mkdir(path.join(home, 'container', 'acme', 'projects'), {
      recursive: true,
    });
    expect(await listApps('acme', home)).toEqual([]);
  });
});
