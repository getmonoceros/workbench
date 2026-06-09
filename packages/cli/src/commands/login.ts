import { defineCommand } from 'citty';
import { consola } from 'consola';
import { runLogin } from '../login/index.js';

export const loginCommand = defineCommand({
  meta: {
    name: 'login',
    group: 'lifecycle',
    description:
      'Log a curated tool in inside the container. Opens the sign-in page in your browser for you — no copying URLs. Today: Claude.',
  },
  args: {
    name: {
      type: 'positional',
      description: 'Container name.',
      required: true,
    },
    feature: {
      type: 'positional',
      description:
        'Which tool to log in (e.g. `claude`). Optional when the container has only one login-capable tool.',
      required: false,
    },
  },
  async run({ args }) {
    try {
      const code = await runLogin({
        name: args.name,
        ...(args.feature ? { feature: args.feature } : {}),
      });
      process.exit(code);
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});
