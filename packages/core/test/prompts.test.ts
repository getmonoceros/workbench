import { describe, expect, it } from 'vitest';

import {
  ARCHITECTURE_PHILOSOPHY_BLOCK,
  buildGeneratorSystemPrompt,
  buildPlannerSystemPrompt,
  buildReviewerSystemPrompt,
} from '../src/index.js';

describe('iteration-prompts', () => {
  describe('ARCHITECTURE_PHILOSOPHY_BLOCK', () => {
    it('is non-empty and contains the architecture marker', () => {
      expect(ARCHITECTURE_PHILOSOPHY_BLOCK).toContain(
        '== ARCHITEKTUR-PHILOSOPHIE ==',
      );
      expect(ARCHITECTURE_PHILOSOPHY_BLOCK.length).toBeGreaterThan(500);
    });

    it('is stack-agnostic — no archive-era stack references leak through', () => {
      // These are markers from the archive's stack-specific philosophy
      // block (Drizzle/Tailwind/shadcn/Fastify-typed-provider-zod /
      // fixed pnpm-workspace paths). Their presence in shared content
      // would mean we accidentally inherited the old assumptions.
      const forbidden = [
        'Drizzle',
        'drizzle-kit',
        'fastify-type-provider-zod',
        'Tailwind v4',
        '@theme',
        'shadcn',
        'apps/api/src',
        'apps/web/src',
        'packages/shared',
      ];
      for (const term of forbidden) {
        expect(ARCHITECTURE_PHILOSOPHY_BLOCK).not.toContain(term);
      }
    });

    it('instructs the agent to discover the stack instead of assuming it', () => {
      expect(ARCHITECTURE_PHILOSOPHY_BLOCK).toContain('STACK-ENTDECKUNG');
      // a representative mix of manifest files across ecosystems must
      // be named explicitly — that is the whole point of the rewrite
      for (const manifest of [
        'package.json',
        'pyproject.toml',
        'pom.xml',
        'go.mod',
        'Cargo.toml',
      ]) {
        expect(ARCHITECTURE_PHILOSOPHY_BLOCK).toContain(manifest);
      }
    });
  });

  describe('phase prompts', () => {
    const phases = [
      { name: 'planner', build: buildPlannerSystemPrompt, role: 'Planner' },
      {
        name: 'generator',
        build: buildGeneratorSystemPrompt,
        role: 'Generator',
      },
      { name: 'reviewer', build: buildReviewerSystemPrompt, role: 'Reviewer' },
    ];

    for (const phase of phases) {
      describe(phase.name, () => {
        const prompt = phase.build();

        it('renders without arguments and embeds the architecture block', () => {
          expect(prompt).toContain(`${phase.role}-Agent`);
          expect(prompt).toContain(ARCHITECTURE_PHILOSOPHY_BLOCK);
        });

        it('describes its JSON output contract', () => {
          expect(prompt).toContain('AUSGABEFORMAT');
          expect(prompt).toContain('camelCase');
        });

        it('does not reference solution-builder-specific routing', () => {
          // The archive embedded Studio-iFrame / Runner-Proxy / BASE_PATH
          // details in generator+reviewer. Those concepts don't exist
          // in the workbench world.
          for (const term of [
            'Studio-iFrame',
            'Runner-Proxy',
            'BASE_PATH',
            '/run/<',
            'MONOCEROS_BASE_PATH',
            '4001',
          ]) {
            expect(prompt).not.toContain(term);
          }
        });
      });
    }
  });
});
