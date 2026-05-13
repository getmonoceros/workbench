import { defineCommand } from 'citty';
import { runApply } from '../devcontainer/compose.js';
import { dispatch } from './_dispatch.js';

export const applyCommand = defineCommand({
  meta: {
    name: 'apply',
    description:
      'Rebuild the devcontainer to materialise pending changes from `add-language` / `add-service` / future `add-*` mutations. Compose-mode: force-remove project containers + drop network (volumes preserved) + devcontainer up. Image-mode: devcontainer up --remove-existing-container.',
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
