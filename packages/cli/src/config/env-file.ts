import { existsSync, readFileSync, promises as fsp } from 'node:fs';
import path from 'node:path';
import type { ResolvedService } from '../create/types.js';

/**
 * Per-container secret/value source. Lives beside the yml profile as
 * `container-configs/<name>.env`, gitignored, and supplies the values
 * for `${VAR}` references in the yml (today: service env values and
 * service commands). Keeping secrets out of the yml — which is meant to
 * be shareable/committable — is the whole point; the threat model is
 * "don't commit credentials to git", not "no plaintext on disk".
 *
 * See docs/backlog.md (init + service redesign) for the design and the
 * parked `cmd:`-resolver follow-up.
 */

// KEY=VALUE, optional leading `export`, `#` comments, surrounding
// single/double quotes stripped. Intentionally minimal — this is a
// dev-time value file, not a full dotenv grammar (no multi-line values,
// no `${}` expansion *within* the env file itself).
const ENV_LINE_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of content.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = ENV_LINE_RE.exec(raw);
    if (!m) continue;
    const key = m[1]!;
    let val = m[2]!.trim();
    if (
      val.length >= 2 &&
      ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'")))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

/** Read + parse `<name>.env`. Returns `{}` when the file is absent. */
export function readEnvFile(envPath: string): Record<string, string> {
  if (!existsSync(envPath)) return {};
  return parseEnvFile(readFileSync(envPath, 'utf8'));
}

/**
 * Ensure `<container-configs>/.gitignore` excludes `*.env`. A builder
 * may version-control their MONOCEROS_HOME / container-configs to share
 * yml profiles across machines (CLAUDE.md: "Synchronisation ist eine
 * Frage von git-Repos"); the per-container env files carry the secrets
 * those yml's reference and must never ride along. Idempotent: leaves an
 * existing pattern + any builder-added rules untouched.
 */
export async function ensureEnvGitignored(configsDir: string): Promise<void> {
  const gitignorePath = path.join(configsDir, '.gitignore');
  const pattern = '*.env';
  let existing = '';
  if (existsSync(gitignorePath)) {
    existing = readFileSync(gitignorePath, 'utf8');
    const lines = existing.split(/\r?\n/).map((l) => l.trim());
    if (lines.includes(pattern)) return;
  }
  const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  const header =
    existing.length === 0
      ? '# Per-container env files hold the secrets behind the yml ${VAR}\n# references. Never commit them.\n'
      : '';
  await fsp.appendFile(gitignorePath, `${prefix}${header}${pattern}\n`);
}

// `${VAR}` only — the explicit-brace form. A bare `$VAR` is left alone
// so a literal env value that happens to contain `$` (a generated
// password, a shell snippet in `command`) survives untouched.
const VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export interface InterpolateResult {
  value: string;
  /** Names referenced by the input that were absent from `vars`. */
  missing: string[];
}

export function interpolate(
  value: string,
  vars: Record<string, string>,
): InterpolateResult {
  const missing: string[] = [];
  const out = value.replace(VAR_RE, (_match, name: string) => {
    if (Object.prototype.hasOwnProperty.call(vars, name)) return vars[name]!;
    missing.push(name);
    return _match; // leave the literal `${VAR}` so the failure is visible
  });
  return { value: out, missing };
}

export interface MissingVar {
  /** Dotted path to the field, e.g. `services.postgres.env.POSTGRES_PASSWORD`
   * or `features.ghcr.io/…:1.apiKey`. */
  location: string;
  name: string;
}

export interface InterpolateServicesResult {
  services: ResolvedService[];
  missing: MissingVar[];
}

/**
 * Substitute `${VAR}` across every string field of each service —
 * image, env values, volume specs, command and the healthcheck test /
 * timing strings. Collects every unresolved reference (across all
 * services and fields) so the caller can fail the apply once with a
 * complete list rather than one var at a time.
 */
export function interpolateServices(
  services: ResolvedService[],
  vars: Record<string, string>,
): InterpolateServicesResult {
  const missing: MissingVar[] = [];
  const resolved = services.map((svc) => {
    const interp = (raw: string, field: string): string => {
      const r = interpolate(raw, vars);
      for (const name of r.missing) {
        missing.push({ location: `services.${svc.name}.${field}`, name });
      }
      return r.value;
    };

    const next: ResolvedService = {
      ...svc,
      image: interp(svc.image, 'image'),
      env: Object.fromEntries(
        Object.entries(svc.env).map(([k, v]) => [k, interp(v, `env.${k}`)]),
      ),
      volumes: svc.volumes.map((v, i) => interp(v, `volumes[${i}]`)),
    };
    if (svc.command !== undefined) {
      next.command = interp(svc.command, 'command');
    }
    if (svc.healthcheck) {
      const hc = svc.healthcheck;
      next.healthcheck = {
        ...hc,
        test: Array.isArray(hc.test)
          ? hc.test.map((t, i) => interp(t, `healthcheck.test[${i}]`))
          : interp(hc.test, 'healthcheck.test'),
        ...(hc.interval !== undefined
          ? { interval: interp(hc.interval, 'healthcheck.interval') }
          : {}),
        ...(hc.timeout !== undefined
          ? { timeout: interp(hc.timeout, 'healthcheck.timeout') }
          : {}),
        ...(hc.startPeriod !== undefined
          ? { startPeriod: interp(hc.startPeriod, 'healthcheck.startPeriod') }
          : {}),
      };
    }
    return next;
  });
  return { services: resolved, missing };
}

export interface InterpolateFeaturesResult {
  features: Record<string, Record<string, string | number | boolean>>;
  missing: MissingVar[];
}

/**
 * Substitute `${VAR}` in feature option *string* values (non-string
 * options pass through). This is what lets credentials like
 * `apiKey: ${ANTHROPIC_API_KEY}` live in `<name>.env` instead of in the
 * shareable yml. Keyed by feature ref → option map, matching the
 * `CreateOptions.features` shape.
 */
export function interpolateFeatures(
  features: Record<string, Record<string, string | number | boolean>>,
  vars: Record<string, string>,
): InterpolateFeaturesResult {
  const missing: MissingVar[] = [];
  const out: Record<string, Record<string, string | number | boolean>> = {};
  for (const [ref, options] of Object.entries(features)) {
    const next: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(options)) {
      if (typeof value !== 'string') {
        next[key] = value;
        continue;
      }
      const r = interpolate(value, vars);
      for (const name of r.missing) {
        missing.push({ location: `features.${ref}.${key}`, name });
      }
      next[key] = r.value;
    }
    out[ref] = next;
  }
  return { features: out, missing };
}

/**
 * Short, builder-facing header for a fresh `<name>.env`. Explains what
 * the file is for; no real keys (a freshly-generated yml has no active
 * `${VAR}` yet — curated services use literal dev-defaults).
 */
export function buildEnvStub(name: string): string {
  return `# Secrets and values for \${VAR} references in ${name}.yml.\n`;
}

export interface EnsureEnvVarsResult {
  /** True when the env file did not exist and was created. */
  created: boolean;
  /** Var keys that were appended (absent before). */
  added: string[];
}

/**
 * Upsert `<name>.env`: create it with the header stub if absent, and
 * append a line for every requested var that isn't already present.
 * Never overwrites existing keys or values.
 *
 * `vars` takes two forms:
 *   - `string[]` → seed each as `KEY=` (blank). Used by `add-feature`
 *     / `init` for credential placeholders the builder must fill.
 *   - `Record<KEY, default>` → seed each as `KEY=<default>`. Used for
 *     curated services, which ship working dev-defaults the builder can
 *     keep as-is or change in one place.
 */
export async function ensureEnvVars(
  envPath: string,
  name: string,
  vars: readonly string[] | Readonly<Record<string, string>>,
): Promise<EnsureEnvVarsResult> {
  const entries: Array<[string, string]> = Array.isArray(vars)
    ? vars.map((v) => [v, ''])
    : Object.entries(vars);
  const exists = existsSync(envPath);
  let content = exists ? readFileSync(envPath, 'utf8') : buildEnvStub(name);
  const present = new Set(Object.keys(parseEnvFile(content)));
  const seen = new Set<string>();
  const toAdd = entries.filter(([k]) => {
    if (present.has(k) || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const added = toAdd.map(([k]) => k);
  if (!exists || added.length > 0) {
    if (content.length > 0 && !content.endsWith('\n')) content += '\n';
    for (const [k, v] of toAdd) content += `${k}=${v}\n`;
    await fsp.mkdir(path.dirname(envPath), { recursive: true });
    await fsp.writeFile(envPath, content);
  }
  return { created: !exists, added };
}

/**
 * Format an actionable error for unresolved `${VAR}` references — names
 * the missing vars, where they're referenced, and the env file the
 * builder should define them in.
 */
export function formatMissingVarsError(
  missing: MissingVar[],
  envPathPretty: string,
): string {
  const lines = missing.map((m) => `  - \${${m.name}} (${m.location})`);
  const uniqueNames = [...new Set(missing.map((m) => m.name))];
  return (
    `Unresolved \${VAR} references in the container yml:\n${lines.join('\n')}\n\n` +
    `Define them in ${envPathPretty}, e.g.\n` +
    uniqueNames.map((n) => `  ${n}=<value>`).join('\n')
  );
}
