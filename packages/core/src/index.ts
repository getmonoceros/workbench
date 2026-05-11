export const CORE_PACKAGE_NAME = '@monoceros/core';

export {
  ARCHITECTURE_PHILOSOPHY_BLOCK,
  buildPlannerSystemPrompt,
  buildGeneratorSystemPrompt,
  buildReviewerSystemPrompt,
} from './prompts/index.js';

export * from './schemas/index.js';
export * from './runtime/index.js';
export * from './orchestrator/index.js';
export * from './persistence/index.js';
