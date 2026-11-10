/**
 * Monoceros features the catalog no longer carries, and the one that replaced
 * each. The old short names keep working on the commands a builder or a
 * plugin may still type: `init --with-features` and `add-feature` take the
 * replacement and say so, `remove-feature` finds the old entry in the yml.
 *
 * Without this, a name that left the catalog breaks every script and plugin
 * that still names it (the discovery plugin's `init` line names
 * `claude-code-roles`), and the remove command that apply prints for an old
 * yml would answer "Unknown feature".
 */
export const RETIRED_FEATURES: Readonly<Record<string, string>> = {
  'claude-code-roles': 'agent-roles',
  'opencode-roles': 'agent-roles',
};

/** The replacement for a retired short name, or undefined. */
export function replacementFor(name: string): string | undefined {
  return Object.hasOwn(RETIRED_FEATURES, name)
    ? RETIRED_FEATURES[name]
    : undefined;
}

/**
 * The ref a retired feature was written into a yml with. Every Monoceros
 * feature is referenced by its major version, and both retired ones only ever
 * had `:1`.
 */
export function retiredFeatureRef(name: string): string {
  return `ghcr.io/getmonoceros/monoceros-features/${name}:1`;
}

/** The one-line notice for a retired name that was resolved to its replacement. */
export function retiredNotice(name: string, replacement: string): string {
  return `'${name}' is replaced by '${replacement}'; using '${replacement}'.`;
}
