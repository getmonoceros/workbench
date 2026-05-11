import { z } from 'zod';

/**
 * Output schemas for the 3-phase iteration pipeline. Each phase
 * produces a forced-JSON output enforced by the Claude Agent SDK via
 * `outputFormat: { type: 'json_schema' }` (see ADR 0003). These Zod
 * schemas are the source of truth for the TypeScript types; the
 * orchestrator converts them to JSON Schema via `z.toJSONSchema()`
 * before passing them to the SDK.
 *
 * Deltas from the archive (`monoceros-for-solution-builder_archive-2026-05-10/
 * packages/shared/src/schemas/iteration-pipeline.ts`):
 *
 *  - `PlanAcceptanceCriterionSchema.source`: `'flow_requirement'` is
 *    renamed to `'existing_requirement'`. The archive's term referred
 *    to the solution-level Plan→Flow data model, which the workbench
 *    no longer carries (see `docs/konzept.md`). The replacement
 *    covers the more general case: any requirement carried into the
 *    iteration from the workspace itself (docs, existing tests,
 *    prior iteration plans).
 *
 *  - `PlanAffectedModule.kind`: archive's `'migration'` is dropped
 *    and replaced by the broader pair `'infra'` and `'tests'`.
 *    `migration` was Drizzle-specific; `infra` covers
 *    migrations/configuration/build-tooling for any stack, and
 *    `tests` distinguishes test-only modules from production code.
 */

// ---- Phase 1: Iteration-Plan ---------------------------------------

export const PlanAcceptanceCriterionSchema = z.object({
  given: z.string().min(1).max(800),
  when: z.string().min(1).max(800),
  then: z.string().min(1).max(800),
  source: z.enum(['derived_from_prompt', 'existing_requirement']),
});
export type PlanAcceptanceCriterion = z.infer<
  typeof PlanAcceptanceCriterionSchema
>;

export const PlanAffectedModuleSchema = z.object({
  name: z.string().min(1).max(120),
  kind: z.enum(['backend', 'frontend', 'shared', 'infra', 'tests']),
  reason: z.string().min(1).max(600),
});
export type PlanAffectedModule = z.infer<typeof PlanAffectedModuleSchema>;

export const PlanFileChangeSchema = z.object({
  path: z.string().min(1).max(300),
  kind: z.enum(['create', 'modify', 'delete']),
  notes: z.string().min(1).max(600),
});
export type PlanFileChange = z.infer<typeof PlanFileChangeSchema>;

export const PlanRiskSchema = z.object({
  description: z.string().min(1).max(1000),
  severity: z.enum(['low', 'medium', 'high']),
});
export type PlanRisk = z.infer<typeof PlanRiskSchema>;

export const IterationPlanSchema = z.object({
  planSummary: z.string().min(1).max(800),
  acceptanceCriteria: z.array(PlanAcceptanceCriterionSchema).min(1).max(20),
  affectedModules: z.array(PlanAffectedModuleSchema).max(20),
  fileChanges: z.array(PlanFileChangeSchema).max(60),
  risks: z.array(PlanRiskSchema).max(20),
  outOfScope: z.array(z.string().min(1).max(500)).max(20),
  planMarkdown: z.string().min(1).max(20_000),
});
export type IterationPlan = z.infer<typeof IterationPlanSchema>;

// ---- Phase 2: Generator-Report -------------------------------------

export const GeneratorTestRunSchema = z.object({
  executed: z.boolean(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  failedTests: z.array(z.string().max(300)).max(50).optional(),
  outputExcerpt: z.string().max(4000).optional(),
});
export type GeneratorTestRun = z.infer<typeof GeneratorTestRunSchema>;

export const PlanDeviationSchema = z.object({
  planItem: z.string().min(1).max(400),
  actualApproach: z.string().min(1).max(600),
  reason: z.string().min(1).max(400),
});
export type PlanDeviation = z.infer<typeof PlanDeviationSchema>;

export const GeneratorReportSchema = z.object({
  changesSummary: z.object({
    filesCreated: z.array(z.string().max(300)).max(60),
    filesModified: z.array(z.string().max(300)).max(60),
    filesDeleted: z.array(z.string().max(300)).max(60),
  }),
  testRun: GeneratorTestRunSchema,
  planDeviations: z.array(PlanDeviationSchema).max(20),
  reviewerNotes: z.array(z.string().min(1).max(600)).max(20),
  selfAssessment: z.object({
    confidence: z.enum(['high', 'medium', 'low']),
    concerns: z.array(z.string().min(1).max(400)).max(20).optional(),
  }),
});
export type GeneratorReport = z.infer<typeof GeneratorReportSchema>;

// ---- Phase 3: Review-Report ----------------------------------------

export const AcceptanceCriterionResultSchema = z.object({
  acIndex: z.number().int().nonnegative(),
  status: z.enum(['met', 'not_met', 'unclear']),
  evidence: z.string().min(1).max(800),
});
export type AcceptanceCriterionResult = z.infer<
  typeof AcceptanceCriterionResultSchema
>;

export const ReviewFindingSchema = z.object({
  category: z.enum(['spec_compliance', 'code_quality', 'security', 'tests']),
  severity: z.enum(['info', 'low', 'medium', 'high']),
  blocking: z.boolean(),
  file: z.string().max(300).optional(),
  line: z.number().int().positive().optional(),
  message: z.string().min(1).max(800),
  suggestion: z.string().max(800).optional(),
});
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

export const ReviewTestVerificationSchema = z.object({
  allTestsPass: z.boolean(),
  failedTests: z.array(z.string().max(300)).max(50).optional(),
});
export type ReviewTestVerification = z.infer<
  typeof ReviewTestVerificationSchema
>;

export const ReviewRecommendationSchema = z.enum([
  'approve',
  'request_changes',
  'reject',
]);
export type ReviewRecommendation = z.infer<typeof ReviewRecommendationSchema>;

export const ReviewReportSchema = z.object({
  acceptanceCriteriaResults: z.array(AcceptanceCriterionResultSchema).max(20),
  findings: z.array(ReviewFindingSchema).max(60),
  testVerification: ReviewTestVerificationSchema,
  recommendation: ReviewRecommendationSchema,
  summary: z.string().min(1).max(800),
});
export type ReviewReport = z.infer<typeof ReviewReportSchema>;
