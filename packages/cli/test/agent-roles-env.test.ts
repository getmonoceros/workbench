import { describe, expect, it } from 'vitest';
import {
  describeRolesEnvVar,
  interpolateRoles,
  rolesRefBlock,
  validateAgentRoles,
} from '../src/create/agent-roles.js';
import { collectEnvPromptCandidates } from '../src/init/env-prompt.js';
import { renderRolesBlock } from '../src/init/generator.js';

const F = 'ghcr.io/getmonoceros/monoceros-features';
const ROLES = `${F}/agent-roles:1`;
const CLAUDE = `${F}/claude-code:1`;

describe('agent-roles models as env references', () => {
  it('resolves the references, and a blank or missing one leaves the field unset', () => {
    const { roles, sources } = interpolateRoles(
      rolesRefBlock(['claude-code']),
      {
        AGENT_ROLES_CLAUDE_PLANNER_MODEL: 'opus',
        AGENT_ROLES_CLAUDE_PLANNER_EFFORT: 'high',
        AGENT_ROLES_CLAUDE_DEVELOPER_MODEL: '  ',
      },
    );
    expect(roles).toEqual({
      planner: { 'claude-code': { model: 'opus', effort: 'high' } },
    });
    expect(sources).toEqual({
      'planner.claude-code.model': 'AGENT_ROLES_CLAUDE_PLANNER_MODEL',
      'planner.claude-code.effort': 'AGENT_ROLES_CLAUDE_PLANNER_EFFORT',
    });
    expect(interpolateRoles(rolesRefBlock(['claude-code']), {}).roles).toBe(
      undefined,
    );
  });

  it('keeps a literal value as it is', () => {
    const { roles, sources } = interpolateRoles(
      { reviewer: { 'claude-code': { model: 'fable', effort: 'max' } } },
      {},
    );
    expect(roles).toEqual({
      reviewer: { 'claude-code': { model: 'fable', effort: 'max' } },
    });
    expect(sources).toEqual({});
  });

  it('names the variable when its value is refused', () => {
    const { roles, sources } = interpolateRoles(
      rolesRefBlock(['claude-code']),
      {
        AGENT_ROLES_CLAUDE_PLANNER_EFFORT: 'hihg',
      },
    );
    expect(() =>
      validateAgentRoles(
        { features: { [CLAUDE]: {}, [ROLES]: {} }, agentRoles: roles },
        sources,
      ),
    ).toThrow(
      /unknown effort 'hihg' for AGENT_ROLES_CLAUDE_PLANNER_EFFORT\. Did you mean 'high'\?/,
    );
  });

  // The same prompt that asks for a feature's token asks for these.
  it('asks for the references like a credential', () => {
    const candidates = collectEnvPromptCandidates(
      [{ ref: ROLES, roles: rolesRefBlock(['claude-code']) }],
      () => undefined,
    );
    expect(candidates.map((c) => c.envVar)).toEqual([
      'AGENT_ROLES_CLAUDE_PLANNER_MODEL',
      'AGENT_ROLES_CLAUDE_PLANNER_EFFORT',
      'AGENT_ROLES_CLAUDE_DEVELOPER_MODEL',
      'AGENT_ROLES_CLAUDE_DEVELOPER_EFFORT',
      'AGENT_ROLES_CLAUDE_REVIEWER_MODEL',
      'AGENT_ROLES_CLAUDE_REVIEWER_EFFORT',
    ]);
    expect(describeRolesEnvVar('AGENT_ROLES_CLAUDE_PLANNER_EFFORT')).toBe(
      "Effort for the planner in Claude Code: low, medium, high, xhigh, max. Empty runs it on the session's.",
    );
  });

  it('init writes one block per agent in the workbench', () => {
    expect(renderRolesBlock([])).toEqual([]);
    const lines = renderRolesBlock(['claude-code', 'copilot']);
    expect(lines.slice(0, 7)).toEqual([
      '    roles:',
      '      planner:',
      '        claude-code:',
      '          model: ${AGENT_ROLES_CLAUDE_PLANNER_MODEL}',
      '          effort: ${AGENT_ROLES_CLAUDE_PLANNER_EFFORT}',
      '        copilot:',
      '          model: ${AGENT_ROLES_COPILOT_PLANNER_MODEL}',
    ]);
    expect(lines.join('\n')).not.toContain('OPENCODE');
  });
});
