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

/**
 * Expand `${VAR}` references *within* the merged env's own values, so a
 * per-container `<name>.env` can point into the global `monoceros-config.env`
 * pool without duplicating the secret (ADR 0031) — e.g.
 * `GITHUB_API_TOKEN=${GIT_TOKEN__GITHUB_KUNDE1}`. Single pass: a value
 * referencing another env key resolves; an unknown reference is left as
 * the literal `${VAR}` (same rule as `interpolate`). Not recursive —
 * one level of indirection is all this needs.
 */
export function expandEnvRefs(
  env: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    out[key] = interpolate(value, env).value;
  }
  return out;
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

/**
 * Env var names for the scaffolded container git-identity placeholders.
 * Single source for: the `${VAR}` rendered into the yml (init generator /
 * add-repo) and the keys seeded blank into `<name>.env`. Resolved at
 * apply time; blank → the identity cascade fills it.
 */
export const GIT_IDENTITY_VAR = {
  name: 'GIT_USER_NAME',
  email: 'GIT_USER_EMAIL',
} as const;

/** True if the string contains at least one `${VAR}` reference. */
export function hasVarPlaceholder(value: string): boolean {
  // Local non-global regex — VAR_RE carries the `g` flag and `.test`
  // on it is stateful (lastIndex), which would make repeated calls flaky.
  return /\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(value);
}

export interface ResolvedGitUserField {
  /**
   * The usable, non-empty resolved value, or undefined when the field
   * has NO usable value — meaning the caller should climb the identity
   * cascade. "No usable value" collapses three cases that are all
   * equivalent for git identity:
   *   - the field was absent,
   *   - it referenced a `${VAR}` missing from the env (`${X}` survives), or
   *   - it resolved to empty / whitespace (a seeded-but-blank `X=` in
   *     `<name>.env`).
   * This mirrors how the schema already treats an empty *literal* as
   * "unset" — an empty `${VAR}` value must behave the same.
   */
  value?: string;
}

export interface ResolvedGitUser {
  name: ResolvedGitUserField;
  email: ResolvedGitUserField;
}

/**
 * Resolve `${VAR}` in a git identity's name + email against the env
 * file, per field. Unlike services/features, an unresolved/empty value
 * is NOT an error: the caller treats a missing `value` as "climb the
 * cascade" (monoceros-config defaults → host → prompt). The email
 * FORMAT of a present value is the caller's check (see `isValidEmail`).
 */
export function resolveGitUserFields(
  user: { name?: string; email?: string },
  vars: Record<string, string>,
): ResolvedGitUser {
  const resolve = (raw: string | undefined): ResolvedGitUserField => {
    if (raw === undefined) return {};
    const r = interpolate(raw, vars);
    // A missing var leaves the literal `${...}` in the value; treat that
    // and an empty/whitespace resolution alike — no usable value.
    if (r.missing.length > 0) return {};
    const trimmed = r.value.trim();
    return trimmed.length > 0 ? { value: trimmed } : {};
  };
  return { name: resolve(user.name), email: resolve(user.email) };
}

interface FeatureLike {
  ref: string;
  options?: Record<string, string | number | boolean>;
}

/**
 * Resolve `${VAR}` in feature option *string* values against the env
 * file, BEFORE the options are merged with the monoceros-config
 * `defaults.features` cascade (config/transform.ts).
 *
 * Unlike services, an unresolved/empty feature option is NOT an error:
 * a string value that references a missing var, OR resolves to
 * empty/whitespace, becomes `""`. The transform's merge then skips
 * empty-string container options, so the option falls through to the
 * global default (or stays unset — e.g. an empty `apiKey` means the
 * feature uses its OAuth/login path). A resolved non-empty value
 * overrides the default. This is why feature credential placeholders
 * can be rendered ACTIVE in the yml (`apiKey: ${VAR}`) with a blank
 * `.env` seed: blank → unset, filled → used. Non-string options
 * (booleans, numbers) pass through untouched.
 *
 * Must run before the transform merge — at that point `apiKey: ${VAR}`
 * is still a non-empty string and would wrongly override the default.
 */
export function interpolateFeatureOptions<T extends FeatureLike>(
  features: readonly T[],
  vars: Record<string, string>,
): T[] {
  return features.map((f) => {
    if (!f.options) return f;
    const opts: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(f.options)) {
      if (typeof value !== 'string') {
        opts[key] = value;
        continue;
      }
      const r = interpolate(value, vars);
      // Missing var (leaves the literal `${...}`) or an empty/whitespace
      // resolution → "" so the transform's empty-skip inherits the
      // default / leaves it unset. Otherwise the trimmed resolved value.
      opts[key] = r.missing.length > 0 ? '' : r.value.trim();
    }
    return { ...f, options: opts };
  });
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
 * Upsert a single `key=value` in `<name>.env`, REPLACING an existing
 * (uncommented) line for `key` in place rather than skipping it as
 * {@link ensureEnvVars} does. Used when apply records a builder's token
 * pick as a reference (`GITHUB_API_TOKEN=${GIT_TOKEN__…}`, ADR 0031): the
 * env is scaffolded with an empty `GITHUB_API_TOKEN=` placeholder, so the
 * reference has to overwrite that line, not be dropped as "already present".
 *
 * Only overwrites when the current value is empty — a non-empty value is
 * the builder's own and is never clobbered. Creates the file with the
 * header stub if absent. Returns whether the file changed.
 */
export async function setEnvVarRef(
  envPath: string,
  name: string,
  key: string,
  value: string,
): Promise<boolean> {
  const exists = existsSync(envPath);
  const content = exists ? readFileSync(envPath, 'utf8') : buildEnvStub(name);
  const lines = content.split(/\r?\n/);
  let replaced = false;
  for (let i = 0; i < lines.length; i++) {
    const m = ENV_LINE_RE.exec(lines[i]!);
    if (m && m[1] === key) {
      if (m[2]!.trim().length > 0) return false; // builder's own value — leave it
      lines[i] = `${key}=${value}`;
      replaced = true;
      break;
    }
  }
  let next = replaced ? lines.join('\n') : content;
  if (!replaced) {
    if (next.length > 0 && !next.endsWith('\n')) next += '\n';
    next += `${key}=${value}\n`;
  }
  if (next === content) return false;
  await fsp.mkdir(path.dirname(envPath), { recursive: true });
  await fsp.writeFile(envPath, next);
  return true;
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
