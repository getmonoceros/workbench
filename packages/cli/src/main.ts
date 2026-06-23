import { defineCommand } from 'citty';
import { addAptPackagesCommand } from './commands/add-apt-packages.js';
import { addFeatureCommand } from './commands/add-feature.js';
import { addFromUrlCommand } from './commands/add-from-url.js';
import { addRepoCommand } from './commands/add-repo.js';
import { addLanguageCommand } from './commands/add-language.js';
import { addPortCommand } from './commands/add-port.js';
import { addServiceCommand } from './commands/add-service.js';
import { applyCommand } from './commands/apply.js';
import { completionCommand } from './commands/completion.js';
import { __bridgeCommand } from './commands/__bridge.js';
import { __completeCommand } from './commands/__complete.js';
import { __updateCheckCommand } from './commands/__update-check.js';
import { initCommand } from './commands/init.js';
import { listAppsCommand } from './commands/list-apps.js';
import { listComponentsCommand } from './commands/list-components.js';
import { logsCommand } from './commands/logs.js';
import { openCommand } from './commands/open.js';
import { portCommand } from './commands/port.js';
import { removeAptPackagesCommand } from './commands/remove-apt-packages.js';
import { removeFeatureCommand } from './commands/remove-feature.js';
import { removeCommand } from './commands/remove.js';
import { restoreCommand } from './commands/restore.js';
import { removeFromUrlCommand } from './commands/remove-from-url.js';
import { removeLanguageCommand } from './commands/remove-language.js';
import { removePortCommand } from './commands/remove-port.js';
import { removeRepoCommand } from './commands/remove-repo.js';
import { removeServiceCommand } from './commands/remove-service.js';
import { runCommand } from './commands/run.js';
import { shellCommand } from './commands/shell.js';
import { startCommand } from './commands/start.js';
import { statusCommand } from './commands/status.js';
import { stopCommand } from './commands/stop.js';
import { tunnelCommand } from './commands/tunnel.js';
import { upgradeCommand } from './commands/upgrade.js';
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
    'list-apps': listAppsCommand,
    'list-components': listComponentsCommand,
    shell: shellCommand,
    open: openCommand,
    run: runCommand,
    logs: logsCommand,
    start: startCommand,
    stop: stopCommand,
    status: statusCommand,
    apply: applyCommand,
    upgrade: upgradeCommand,
    remove: removeCommand,
    restore: restoreCommand,
    'add-service': addServiceCommand,
    'add-language': addLanguageCommand,
    'add-apt-packages': addAptPackagesCommand,
    'add-feature': addFeatureCommand,
    'add-from-url': addFromUrlCommand,
    'add-repo': addRepoCommand,
    'add-port': addPortCommand,
    'remove-service': removeServiceCommand,
    'remove-language': removeLanguageCommand,
    'remove-apt-packages': removeAptPackagesCommand,
    'remove-feature': removeFeatureCommand,
    'remove-from-url': removeFromUrlCommand,
    'remove-repo': removeRepoCommand,
    'remove-port': removePortCommand,
    port: portCommand,
    tunnel: tunnelCommand,
    completion: completionCommand,
    __complete: __completeCommand,
    '__update-check': __updateCheckCommand,
    __bridge: __bridgeCommand,
  },
});
