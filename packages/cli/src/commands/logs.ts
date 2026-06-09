import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { defineCommand } from 'citty';
import { containerDir, containerLogsDir } from '../config/paths.js';
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
      'Tail logs from a compose service of the named dev-container, or from a long-running app started inside it (logs/<app>.log). Pass --no-follow for a one-shot dump.',
  },
  args: {
    name: {
      type: 'positional',
      description:
        'Container name (yml in $MONOCEROS_HOME/container-configs/).',
      required: true,
    },
    service: {
      type: 'string',
      description:
        'A compose service (e.g. postgres) or an app whose log is at logs/<service>.log. Defaults to all compose services.',
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
    const service = typeof args.service === 'string' ? args.service : undefined;
    // App log written by a detached in-container server takes precedence when
    // a matching file exists; otherwise fall through to compose service logs.
    if (service) {
      const logFile = path.join(containerLogsDir(args.name), `${service}.log`);
      if (existsSync(logFile)) {
        return dispatch(() => tailLogFile(logFile, args.follow));
      }
    }
    return dispatch(() =>
      runLogs({
        root: containerDir(args.name),
        ...(service ? { service } : {}),
        follow: args.follow,
      }),
    );
  },
});
