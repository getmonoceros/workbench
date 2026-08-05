import { defineCommand } from 'citty';
import { consola } from 'consola';
import type { FeatureOptions } from '../create/types.js';
import { getInnerArgs } from '../inner-args.js';
import { runAddMcpServer } from '../modify/index.js';
import { parseOptionsAfterDashes } from './add-feature.js';

export const addMcpServerCommand = defineCommand({
  meta: {
    name: 'add-mcp-server',
    group: 'edit',
    description:
      "Register an MCP server with the agents in this container, so they can reach it without being told about it. Takes a catalog connector name (see `monoceros list-components`); options follow `--` as `key=value` pairs. A server the catalog does not carry is a hand-written entry in the yml's `mcpServers:` block, using the config its provider publishes. Already present with different options is an error (remove + re-add to change it).",
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
        'Catalog connector to register (e.g. `context7` — see `monoceros list-components`). Its credential options are seeded into `<name>.env` as `${VAR}` placeholders for you to fill; `-- key=value` sets a value directly instead.',
      required: true,
    },
  },
  async run({ args }) {
    let options: FeatureOptions;
    try {
      options = parseOptionsAfterDashes(getInnerArgs());
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    try {
      await runAddMcpServer({
        name: args.name,
        connector: args.connector,
        options,
      });
      process.exit(0);
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});
