import { defineCommand } from 'citty';
import { runApply } from '../devcontainer/compose.js';
import { dispatch } from './_dispatch.js';

export const applyCommand = defineCommand({
  meta: {
    name: 'apply',
    description:
      'Rebuild the devcontainer to materialise pending changes from `add-language` / `add-service` / `add-apt-packages` mutations. Compose-mode: force-remove project containers + drop network (volumes preserved) + devcontainer up. Image-mode: devcontainer up --remove-existing-container. Close any VS Code Remote Containers session first — the extension auto-recreates containers and races with apply.',
  },
  args: {
    project: {
      type: 'string',
      description:
        'Override the auto-detected project (path, absolute or relative to cwd).',
    },
  },
  run({ args }) {
    return dispatch(() =>
      runApply({
        project: typeof args.project === 'string' ? args.project : undefined,
      }),
    );
  },
});
