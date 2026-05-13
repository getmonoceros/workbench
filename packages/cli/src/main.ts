import { defineCommand } from 'citty';
import { addLanguageCommand } from './commands/add-language.js';
import { addServiceCommand } from './commands/add-service.js';
import { applyCommand } from './commands/apply.js';
import { createCommand } from './commands/create.js';
import { downCommand } from './commands/down.js';
import { logsCommand } from './commands/logs.js';
import { runCommand } from './commands/run.js';
import { shellCommand } from './commands/shell.js';
import { startCommand } from './commands/start.js';
import { statusCommand } from './commands/status.js';
import { stopCommand } from './commands/stop.js';
import { CLI_VERSION } from './version.js';

export const main = defineCommand({
  meta: {
    name: 'monoceros',
    version: CLI_VERSION,
    description:
      'Monoceros workbench — local, sandboxed AI-coding environment for solution builders.',
  },
  subCommands: {
    create: createCommand,
    shell: shellCommand,
    run: runCommand,
    logs: logsCommand,
    start: startCommand,
    stop: stopCommand,
    down: downCommand,
    status: statusCommand,
    apply: applyCommand,
    'add-service': addServiceCommand,
    'add-language': addLanguageCommand,
  },
});
