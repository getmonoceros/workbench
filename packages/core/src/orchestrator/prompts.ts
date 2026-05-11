import type { GeneratorReport, IterationPlan } from '../schemas/index.js';

/**
 * User-prompt builders for Phase 2 and Phase 3. Phase 1 (Planner)
 * receives the Builder's free-form prompt verbatim; later phases get
 * the previous phases' structured outputs appended so they don't
 * need to re-read the iteration archive.
 */
export function buildGeneratorUserPrompt(
  originalPrompt: string,
  plan: IterationPlan,
): string {
  return [
    '## Original-Prompt der Iteration',
    '',
    originalPrompt,
    '',
    '## Iterations-Plan (Phase 1)',
    '',
    '```json',
    JSON.stringify(plan, null, 2),
    '```',
    '',
    'Setze diesen Plan im Workspace um. Folge dem Workflow aus deinem',
    'System-Prompt — Plan lesen, inkrementell implementieren, Tests',
    'schreiben/laufen lassen, Build/Live-Probe falls relevant. Liefere',
    'am Ende den Generator-Report als JSON.',
  ].join('\n');
}

export function buildReviewerUserPrompt(
  originalPrompt: string,
  plan: IterationPlan,
  report: GeneratorReport,
): string {
  return [
    '## Original-Prompt der Iteration',
    '',
    originalPrompt,
    '',
    '## Iterations-Plan (Phase 1)',
    '',
    '```json',
    JSON.stringify(plan, null, 2),
    '```',
    '',
    '## Generator-Report (Phase 2)',
    '',
    '```json',
    JSON.stringify(report, null, 2),
    '```',
    '',
    'Beurteile, ob die Code-Änderungen den Plan sauber umgesetzt haben.',
    'Führe die Pflicht-Probes aus deinem System-Prompt aus und liefere',
    'den Review-Report als JSON.',
  ].join('\n');
}
