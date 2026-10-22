import type { AgentsMdInput } from './agents-md.js';
import { formatLimits, WORKSPACE } from '../limits/index.js';

/**
 * Generates `.monoceros/resources.md` - the "Memory and CPU limits" chapter,
 * imported by AGENTS.md (ADR 0062).
 *
 * The agent is the one whose build hits the limit, and all it sees is
 * `Killed` or exit 137: the named OOM message from `apply`, `run` and
 * `status` reaches the user on the host, not the agent in here. So this
 * chapter says what the limits are, why they exist, where they are set, how
 * to recognise a kill from inside, and what to do about it. AGENTS.md keeps
 * the rule as a one-liner and the figures in its inventory.
 */
export function generateResourcesMd(
  input: Pick<AgentsMdInput, 'containerName' | 'limits'>,
): string {
  const name = input.containerName;
  const limited = (input.limits ?? []).filter(
    (l) => l.memory !== undefined || l.cpus !== undefined,
  );
  const workspace = limited.find((l) => l.name === WORKSPACE);

  const lines: string[] = [];

  lines.push('# Memory and CPU limits');
  lines.push('');
  lines.push(
    'The long form of the memory rule in `AGENTS.md`: what the limits of this',
    'workbench are, why they exist, where they are set, and what to do when',
    'your work runs into one.',
  );
  lines.push('');

  lines.push('## The limits of this workbench');
  lines.push('');
  if (limited.length > 0) {
    lines.push(`${formatLimits(limited)}.`);
    lines.push('');
    lines.push(
      'A container that is not named runs without a limit. Without a limit it',
      'can still run out of the memory Docker has in total.',
    );
  } else {
    lines.push(
      'None. Every container of this workbench runs without a limit and can use',
      'all the memory Docker has. It can still run out of that.',
    );
  }
  lines.push('');

  lines.push('## Why they exist');
  lines.push('');
  lines.push(
    'All containers of a workbench share the memory Docker has. On macOS and',
    'Windows that is the fixed memory of the Docker VM, shared with every other',
    'workbench that is up. Without a limit, one runaway build or one service',
    'can take all of it and the others fail with it. A machine that runs',
    'workbenches unattended also plans with these figures before it starts one.',
    'Docker enforces the limits. A process that goes over the memory limit is',
    'killed by the kernel. A container over its CPU limit is slowed down, not',
    'stopped.',
  );
  lines.push('');

  lines.push('## Where they are set');
  lines.push('');
  lines.push(
    `In the yml on the host, \`container-configs/${name}.yml\`. \`resources:\` at`,
    'the top level is the limit of this container, the workspace. `resources:`',
    'in a service entry is the limit of that service:',
  );
  lines.push('');
  lines.push('```yaml');
  lines.push('resources:');
  lines.push('  memory: 6g');
  lines.push('  cpus: 2');
  lines.push('services:');
  lines.push('  - name: postgres');
  lines.push('    resources:');
  lines.push('      memory: 1g');
  lines.push('```');
  lines.push('');
  lines.push(
    '- `memory` is a number with a unit: `512m`, `2g`, `1.5g`.',
    '- `cpus` is how many CPUs the container may use, like `0.5` or `2`.',
    '- A value written in the yml always applies.',
    '- A machine can also enforce a default limit on every container',
    "  (`MONOCEROS_ENFORCE_DEFAULT_LIMITS` in the host's `monoceros-config.env`).",
    '  A value in the yml replaces the default for that one field.',
    `- A change takes effect with \`monoceros apply ${name}\` on the host.`,
    '- No `monoceros` command sets a limit. It is an edit to the yml, and the',
    '  user makes it.',
  );
  lines.push('');

  lines.push('## How a kill looks from in here');
  lines.push('');
  lines.push(
    '- **In this container:** the kernel kills the process that uses the most',
    '  memory. That is usually your build, your test run or a language server.',
    '  You see `Killed` or exit code 137. The container itself keeps running.',
    '- **Confirm it** with `cat /sys/fs/cgroup/memory.events`: the `oom_kill`',
    '  count goes up with every kill. `cat /sys/fs/cgroup/memory.max` is the',
    '  limit in bytes, `max` means none.',
    '- **In a service:** Docker restarts it, and it can die again in a loop.',
    '  From here that looks like `connection refused` or a dropped connection.',
    '  You cannot see other containers from inside. Ask the user to run',
    `  \`monoceros status ${name}\`. It names a service that ran out of memory.`,
  );
  lines.push('');

  lines.push('## What to do');
  lines.push('');
  lines.push(
    '1. **Do not retry it as it is.** It dies the same way again.',
    '2. **Make the work smaller first.** Run fewer build or test workers, keep',
    '   a JVM or Node heap below the limit, build one module at a time. `nproc`',
    '   reports every CPU of the host, not the `cpus` limit, so a tool that',
    '   sizes its worker pool from it starts too many workers. The CPU limit is',
    '   the quota in `/sys/fs/cgroup/cpu.max` (quota and period in',
    '   microseconds).',
    '3. **If the work needs more,** tell the user which container needs more',
    '   and why. Give them the yml lines with the new value and the apply',
    '   command, each in a fenced code block:',
  );
  lines.push('');
  lines.push('```yaml');
  lines.push('resources:');
  lines.push(`  memory: ${suggestMore(workspace?.memory)}`);
  lines.push('```');
  lines.push('');
  lines.push('```');
  lines.push(`monoceros apply ${name}`);
  lines.push('```');
  lines.push('');
  lines.push(
    'Do not work around a limit, for example with retry loops or by spreading',
    "the work over background processes. The limit is the user's decision.",
  );
  lines.push('');

  return lines.join('\n');
}

/** The example value in the "ask for more" block: double the current one. */
function suggestMore(memory: string | undefined): string {
  if (memory === undefined) return '8g';
  const unit = memory.slice(-1);
  const value = Number(memory.slice(0, -1));
  return `${value * 2}${unit}`;
}
