/**
 * Pure helpers for mapping container features to the login services
 * Monoceros can drive. Kept dependency-free so the completion path can
 * import it without pulling in the login orchestrator (http server, spawns).
 */

/**
 * Leaf of an OCI feature ref, tag stripped:
 * `ghcr.io/getmonoceros/monoceros-features/claude-code:1` → `claude-code`.
 */
export function featureLeaf(ref: string): string {
  const noTag = ref.replace(/:[^/:]*$/, '');
  return noTag.slice(noTag.lastIndexOf('/') + 1);
}

// Feature leaf → the login service name the user types. Only features whose
// login Monoceros can actually drive belong here. First cut: Claude.
const LOGIN_SERVICE_BY_LEAF: Record<string, string> = {
  'claude-code': 'claude',
};

/** Login-capable services present in a container's feature ref list. */
export function loginCapableServices(refs: readonly string[]): string[] {
  const out: string[] = [];
  for (const ref of refs) {
    const service = LOGIN_SERVICE_BY_LEAF[featureLeaf(ref)];
    if (service && !out.includes(service)) out.push(service);
  }
  return out;
}

/**
 * Parse the localhost callback target out of a Claude OAuth URL. Returns the
 * port + path of `redirect_uri` when it points at localhost (the auto-callback
 * flow), or null otherwise (e.g. the manual paste-code flow against
 * platform.claude.com).
 */
export function parseCallbackTarget(
  authUrl: string,
): { port: number; pathname: string } | null {
  try {
    const u = new URL(authUrl);
    const redirect = u.searchParams.get('redirect_uri');
    if (!redirect) return null;
    const r = new URL(redirect);
    if (r.hostname !== 'localhost' && r.hostname !== '127.0.0.1') return null;
    const port = Number(r.port);
    if (!Number.isInteger(port) || port <= 0) return null;
    return { port, pathname: r.pathname };
  } catch {
    return null;
  }
}
