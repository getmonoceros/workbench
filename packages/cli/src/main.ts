import { defineCommand } from 'citty';
import { addAptPackagesCommand } from './commands/add-apt-packages.js';
import { addFeatureCommand } from './commands/add-feature.js';
import { addFromUrlCommand } from './commands/add-from-url.js';
import { addRepoCommand } from './commands/add-repo.js';
import { addLanguageCommand } from './commands/add-language.js';
import { addServiceCommand } from './commands/add-service.js';
import { applyCommand } from './commands/apply.js';
import { downCommand } from './commands/down.js';
import { initCommand } from './commands/init.js';
import { logsCommand } from './commands/logs.js';
import { removeAptPackagesCommand } from './commands/remove-apt-packages.js';
import { removeFeatureCommand } from './commands/remove-feature.js';
import { removeFromUrlCommand } from './commands/remove-from-url.js';
import { removeLanguageCommand } from './commands/remove-language.js';
import { removeRepoCommand } from './commands/remove-repo.js';
import { removeServiceCommand } from './commands/remove-service.js';
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
    init: initCommand,
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
    'add-apt-packages': addAptPackagesCommand,
    'add-feature': addFeatureCommand,
    'add-from-url': addFromUrlCommand,
    'add-repo': addRepoCommand,
    'remove-service': removeServiceCommand,
    'remove-language': removeLanguageCommand,
    'remove-apt-packages': removeAptPackagesCommand,
    'remove-feature': removeFeatureCommand,
    'remove-from-url': removeFromUrlCommand,
    'remove-repo': removeRepoCommand,
  },
});
