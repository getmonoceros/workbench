import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  GeneratorReportSchema,
  IterationPlanSchema,
  ReviewReportSchema,
  type IterationPlan,
  type GeneratorReport,
  type ReviewReport,
} from '../src/index.js';

const validPlan: IterationPlan = {
  planSummary: 'Add a /healthz endpoint returning 200 OK.',
  acceptanceCriteria: [
    {
      given: 'service is running',
      when: 'GET /healthz is called',
      then: 'response is 200 OK with body { ok: true }',
      source: 'derived_from_prompt',
    },
  ],
  affectedModules: [
    {
      name: 'src/routes/healthz',
      kind: 'backend',
      reason: 'new endpoint lives here',
    },
  ],
  fileChanges: [
    {
      path: 'src/routes/healthz.ts',
      kind: 'create',
      notes: 'minimal handler returning the ok payload',
    },
  ],
  risks: [],
  outOfScope: ['authentication on /healthz'],
  planMarkdown: '# Plan\n\nAdd a healthz endpoint.',
};

const validGeneratorReport: GeneratorReport = {
  changesSummary: {
    filesCreated: ['src/routes/healthz.ts'],
    filesModified: ['src/routes/index.ts'],
    filesDeleted: [],
  },
  testRun: {
    executed: true,
    passed: 3,
    failed: 0,
  },
  planDeviations: [],
  reviewerNotes: ['Endpoint deliberately unauthenticated as planned'],
  selfAssessment: {
    confidence: 'high',
  },
};

const validReviewReport: ReviewReport = {
  acceptanceCriteriaResults: [
    {
      acIndex: 0,
      status: 'met',
      evidence: 'src/routes/healthz.ts:8 returns 200 with { ok: true }',
    },
  ],
  findings: [],
  testVerification: {
    allTestsPass: true,
  },
  recommendation: 'approve',
  summary: 'All ACs met, tests green, build clean.',
};

describe('iteration-pipeline schemas', () => {
  describe('IterationPlanSchema', () => {
    it('parses a valid plan', () => {
      expect(() => IterationPlanSchema.parse(validPlan)).not.toThrow();
    });

    it('accepts the renamed AC source "existing_requirement"', () => {
      const plan = {
        ...validPlan,
        acceptanceCriteria: [
          {
            ...validPlan.acceptanceCriteria[0]!,
            source: 'existing_requirement',
          },
        ],
      };
      expect(() => IterationPlanSchema.parse(plan)).not.toThrow();
    });

    it('rejects the archive-era AC source "flow_requirement"', () => {
      const plan = {
        ...validPlan,
        acceptanceCriteria: [
          { ...validPlan.acceptanceCriteria[0]!, source: 'flow_requirement' },
        ],
      };
      expect(() => IterationPlanSchema.parse(plan)).toThrow();
    });

    it('accepts the broadened module kinds "infra" and "tests"', () => {
      for (const kind of ['infra', 'tests'] as const) {
        const plan = {
          ...validPlan,
          affectedModules: [{ ...validPlan.affectedModules[0]!, kind }],
        };
        expect(() => IterationPlanSchema.parse(plan)).not.toThrow();
      }
    });

    it('rejects the archive-era module kind "migration"', () => {
      const plan = {
        ...validPlan,
        affectedModules: [
          { ...validPlan.affectedModules[0]!, kind: 'migration' },
        ],
      };
      expect(() => IterationPlanSchema.parse(plan)).toThrow();
    });

    it('requires at least one acceptance criterion', () => {
      expect(() =>
        IterationPlanSchema.parse({ ...validPlan, acceptanceCriteria: [] }),
      ).toThrow();
    });

    it('enforces planSummary length bounds', () => {
      expect(() =>
        IterationPlanSchema.parse({ ...validPlan, planSummary: '' }),
      ).toThrow();
      expect(() =>
        IterationPlanSchema.parse({
          ...validPlan,
          planSummary: 'x'.repeat(801),
        }),
      ).toThrow();
    });
  });

  describe('GeneratorReportSchema', () => {
    it('parses a valid report', () => {
      expect(() =>
        GeneratorReportSchema.parse(validGeneratorReport),
      ).not.toThrow();
    });

    it('rejects negative test counts', () => {
      expect(() =>
        GeneratorReportSchema.parse({
          ...validGeneratorReport,
          testRun: { ...validGeneratorReport.testRun, passed: -1 },
        }),
      ).toThrow();
    });

    it('rejects unknown confidence values', () => {
      expect(() =>
        GeneratorReportSchema.parse({
          ...validGeneratorReport,
          selfAssessment: { confidence: 'maybe' },
        }),
      ).toThrow();
    });
  });

  describe('ReviewReportSchema', () => {
    it('parses a valid report', () => {
      expect(() => ReviewReportSchema.parse(validReviewReport)).not.toThrow();
    });

    it('rejects unknown recommendations', () => {
      expect(() =>
        ReviewReportSchema.parse({
          ...validReviewReport,
          recommendation: 'merge',
        }),
      ).toThrow();
    });

    it('rejects unknown finding categories', () => {
      expect(() =>
        ReviewReportSchema.parse({
          ...validReviewReport,
          findings: [
            {
              category: 'performance',
              severity: 'low',
              blocking: false,
              message: 'x',
            },
          ],
        }),
      ).toThrow();
    });
  });

  describe('JSON-Schema conversion for the Agent SDK', () => {
    it('converts every pipeline schema to a Draft-2020-12 JSON Schema', () => {
      for (const schema of [
        IterationPlanSchema,
        GeneratorReportSchema,
        ReviewReportSchema,
      ]) {
        const json = z.toJSONSchema(schema);
        expect(json).toMatchObject({
          type: 'object',
          properties: expect.any(Object),
          required: expect.any(Array),
        });
        // SDK json_schema enforcement relies on additionalProperties:
        // false — Zod 4 emits that by default for z.object.
        expect(
          (json as { additionalProperties?: unknown }).additionalProperties,
        ).toBe(false);
      }
    });
  });
});
