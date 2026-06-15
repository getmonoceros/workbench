import type { ServiceObject } from '../config/schema.js';

/**
 * Renders a `services:` entry as YAML lines for the **map body** at
 * column 0 (no leading `- `). Two consumers share this:
 *   - the init generator indents the body into a sequence item;
 *   - `add-service` parses the body into a node and appends it to the
 *     services seq (comments and all).
 *
 * Curated services render fully active (every catalog default visible
 * and editable). Custom images render `name` + `image` active plus a
 * commented scaffold of the optional fields — Monoceros can't know a
 * non-curated image's env/ports/volumes, so it shows the knobs rather
 * than guessing.
 */

/** Full active map body for a known ServiceObject (curated, expanded). */
export function renderServiceObjectBody(svc: ServiceObject): string[] {
  const lines: string[] = [`name: ${svc.name}`, `image: ${svc.image}`];
  if (svc.user !== undefined)
    lines.push(`user: '${svc.user.replace(/'/g, "''")}'`);
  if (svc.port !== undefined) lines.push(`port: ${svc.port}`);
  if (svc.env && Object.keys(svc.env).length > 0) {
    lines.push('env:');
    for (const [k, v] of Object.entries(svc.env)) {
      lines.push(`  ${k}: ${v}`);
    }
  }
  if (svc.volumes && svc.volumes.length > 0) {
    lines.push('volumes:');
    for (const vol of svc.volumes) lines.push(`  - ${vol}`);
  }
  if (svc.restart) lines.push(`restart: ${svc.restart}`);
  if (svc.command !== undefined) lines.push(`command: ${svc.command}`);
  if (svc.healthcheck) {
    lines.push('healthcheck:');
    const test = svc.healthcheck.test;
    lines.push(
      Array.isArray(test)
        ? `  test: [${test.map((t) => JSON.stringify(t)).join(', ')}]`
        : `  test: ${test}`,
    );
    if (svc.healthcheck.interval)
      lines.push(`  interval: ${svc.healthcheck.interval}`);
    if (svc.healthcheck.timeout)
      lines.push(`  timeout: ${svc.healthcheck.timeout}`);
    if (svc.healthcheck.retries !== undefined)
      lines.push(`  retries: ${svc.healthcheck.retries}`);
    if (svc.healthcheck.startPeriod)
      lines.push(`  startPeriod: ${svc.healthcheck.startPeriod}`);
  }
  // Connection-env templates travel WITH the instance (ADR 0021), so a
  // renamed/duplicated curated service (e.g. `add-service postgres
  // --as=analytics`) keeps them: at apply `serviceConnectionEnv` reads
  // them off the service and prefixes by the instance's own name
  // (`ANALYTICS_*`). Without this, a renamed instance would fall back to a
  // catalog-by-name lookup that misses, and get no connection env at all.
  // Single-quoted: the templates contain `:`/`/`/`@` and `${…}` render
  // tokens that must survive verbatim (interpolateServices leaves
  // connectionEnv untouched).
  if (svc.connectionEnv && Object.keys(svc.connectionEnv).length > 0) {
    lines.push('connectionEnv:');
    for (const [k, v] of Object.entries(svc.connectionEnv)) {
      lines.push(`  ${k}: '${v.replace(/'/g, "''")}'`);
    }
  }
  return lines;
}

/**
 * A custom (non-curated) image entry: `name` + `image` active, the rest
 * as a commented scaffold so the builder sees the fields Monoceros can't
 * infer. Returns the active body lines plus the scaffold as a YAML
 * `comment` string (no leading `#` — the serializer adds it; attaching
 * it as `node.comment` is the only way the comment survives being moved
 * into the services sequence).
 */
export function renderCustomService(
  name: string,
  image: string,
): { bodyLines: string[]; comment: string } {
  const bodyLines = [`name: ${name}`, `image: ${image}`];
  const comment = [
    ' port: 8080                 # in-container port → `monoceros tunnel`',
    ' env:                       # values resolved from <name>.env',
    '   KEY: ${SOME_VAR}',
    ' volumes:',
    `   - data:/data             # persistent host bind-mount under data/${name}`,
    '   - rel/host/path:/in/container:ro',
    ' healthcheck:',
    '   test: curl -f http://localhost:8080/health',
    ' restart: unless-stopped',
  ].join('\n');
  return { bodyLines, comment };
}

/**
 * One-line builder-facing hint printed after a custom service is added,
 * pointing at the commented scaffold the builder needs to fill in.
 */
export function customServiceHint(name: string): string {
  return (
    `'${name}' is a custom image — Monoceros doesn't know its env, ports or volumes. ` +
    `Review the commented block under services[].${name} in the yml and fill in what the image needs.`
  );
}
