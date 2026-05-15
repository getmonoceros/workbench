export {
  CONFIG_SCHEMA_VERSION,
  ExternalServicesSchema,
  FeatureEntrySchema,
  FeatureOptionValueSchema,
  GitUserSchema,
  REGEX,
  RepoEntrySchema,
  SolutionConfigSchema,
  validateConfig,
} from './schema.js';
export type {
  ExternalServices,
  FeatureEntry,
  GitUser,
  RepoEntry,
  SolutionConfig,
} from './schema.js';
export {
  createDoc,
  parseConfig,
  readConfig,
  stringifyConfig,
  writeConfig,
} from './io.js';
export type { ParsedConfig } from './io.js';
