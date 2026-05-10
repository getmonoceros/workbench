// Single source of truth for the CLI version. Kept in sync with
// packages/cli/package.json by hand for now.
//
// Versioning policy: one minor version per milestone (0.1.x = M1,
// 0.2.x = M2, 0.3.x = M3, 1.0.0 = public). `-dev` marks an open
// milestone; it drops when the milestone's Definition of Done is met.
export const CLI_VERSION = '0.1.0-dev';
