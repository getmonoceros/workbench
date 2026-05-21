// Single source of truth for the CLI version. Kept in sync with
// `packages/cli/package.json` by hand — the release-cli workflow
// reads the value from `package.json` and refuses to publish if the
// two are out of step, so a manual desync gets caught loudly.
export const CLI_VERSION = '1.4.0';
