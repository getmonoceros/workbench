import { spawn } from 'node:child_process';
import path from 'node:path';
import { defineCommand } from 'citty';
import { consola } from 'consola';
import { containerDir, containerLogsDir } from '../config/paths.js';
import { readLaunchConfig, resolveTarget } from '../config/launch-config.js';
import { runLogs } from '../devcontainer/compose.js';
import { dispatch } from './_dispatch.js';

/**
 * Tail a host-side log file (an app log written by a detached server inside
 * the container — the logs dir is bind-mounted, so it's readable here). With
 * follow, `tail -F` shows recent output and keeps streaming (and waits for
 * the file if it doesn't exist yet); otherwise the whole file is dumped once.
 */
function tailLogFile(file: string, follow: boolean): Promise<number> {
  const [cmd, args] = follow ? ['tail', ['-F', file]] : ['cat', [file]];
  return new Promise((resolve, reject) => {
    const child = spawn(cmd as string, args as string[], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 0));
  });
}

export const logsCommand = defineCommand({
  meta: {
    name: 'logs',
    group: 'run',
    description:
      'Tail logs from a compose service of the named dev-container, or from a long-running app started inside it. Pass --no-follow for a one-shot dump.',
  },
  args: {
    name: {
      type: 'positional',
      description:
        'Container name (yml in $MONOCEROS_HOME/container-configs/).',
      required: true,
    },
    app: {
      type: 'positional',
      description:
        'An app (a path under projects/ with .monoceros/launch.json) whose log to tail, or a compose service (e.g. postgres). Defaults to all compose services.',
      required: false,
    },
    target: {
      type: 'string',
      description:
        'Which launch target of the app to tail (defaults to its "default" target, or its only one).',
    },
    follow: {
      type: 'boolean',
      description:
        'Follow log output (default: true). Use --no-follow to disable.',
      alias: ['f'],
      default: true,
    },
  },
  run({ args }) {
    const app = typeof args.app === 'string' ? args.app : undefined;
    const target = typeof args.target === 'string' ? args.target : undefined;
    return dispatch(async () => {
      if (app) {
        // An app with a launch config tails logs/<app>/<target>.log; resolve
        // the target host-side (works with the container stopped).
        const cfg = await readLaunchConfig(args.name, app);
        if (cfg) {
          const t = resolveTarget(cfg, target, app);
          const logFile = path.join(
            containerLogsDir(args.name),
            app,
            `${t.name}.log`,
          );
          return tailLogFile(logFile, args.follow);
        }
        if (target) {
          // --target only makes sense for an app with a launch config.
          consola.warn(
            `No launch config for "${app}" — ignoring --target and treating "${app}" as a compose service.`,
          );
        }
        // No launch config: fall through to treating it as a compose service.
        return runLogs({
          root: containerDir(args.name),
          service: app,
          follow: args.follow,
        });
      }
      return runLogs({ root: containerDir(args.name), follow: args.follow });
    });
  },
});
