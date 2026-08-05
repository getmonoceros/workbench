import { defineCommand } from 'citty';
import { consola } from 'consola';
import { runRemoveMcpServer } from '../modify/index.js';

export const removeMcpServerCommand = defineCommand({
  meta: {
    name: 'remove-mcp-server',
    group: 'edit',
    description:
      'Remove an MCP server from the container config. Takes the name as it stands in the yml, so it works for a hand-written entry as well as a catalog connector. Idempotent, prints a diff before writing. The registration disappears from the agent on the next apply.',
  },
  args: {
    name: {
      type: 'positional',
      description:
        'Container name (yml in $MONOCEROS_HOME/container-configs/).',
      required: true,
    },
    connector: {
      type: 'positional',
      description:
        "MCP server to remove, by the name it has in the yml's `mcpServers:` block (e.g. `context7`).",
      required: true,
    },
  },
  async run({ args }) {
    try {
      await runRemoveMcpServer({
        name: args.name,
        connector: args.connector,
      });
      process.exit(0);
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});
