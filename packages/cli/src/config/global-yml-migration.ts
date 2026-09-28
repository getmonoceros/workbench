import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import { loadDescriptorCatalog } from '../catalog/load.js';
import { featureOptionVarName } from '../init/feature-doc.js';
import { matchMonocerosFeature } from '../util/ref.js';
import { parseEnvFile, setEnvVarRef } from './env-file.js';
import { DEFAULT_UPGRADE_STALE_DAYS } from './machine-state.js';
import { globalEnvPath, prettyPath, workbenchRoot } from './paths.js';

/**
 * One-time migration of the retired `<MONOCEROS_HOME>/monoceros-config.yml`
 * into `monoceros-config.env` (ADR 0061).
 *
 * Runs from `readMachineSettings`, so every command that needs a machine-wide
 * setting does it: apply, start, status, port, add-port and remove-port. The
 * other add-* commands read none and leave the yml for the next apply. Afterwards the yml is
 * renamed to `monoceros-config.yml.migrated`, and every later run finds no
 * yml and does nothing.
 *
 * What moves, and what does not:
 *   - Every key whose value differs from its default moves into the env:
 *     `routing.hostPort`, `upgrade.staleDays`, `defaults.git.user`.
 *   - A `defaults.features` option that a workbench yml takes from the env
 *     (`surface: env`, a credential) moves under the variable name that yml
 *     already references, e.g. `CLAUDE_CODE_API_KEY`.
 *   - Any other `defaults.features` option cannot go into an env: nothing
 *     reads it from there. It is listed for the builder to carry into the
 *     workbench yml.
 *   - A key the env already sets is never overwritten. The env wins, and the
 *     message says the yml value was dropped.
 *
 * Values are never printed: a moved key may be a token.
 */

export const LEGACY_GLOBAL_YML = 'monoceros-config.yml';
const MIGRATED_SUFFIX = '.migrated';
const LEGACY_DEFAULT_HOST_PORT = 80;

/**
 * The retired file's schema, kept only to read it for the migration. Loose on
 * purpose: this runs once on files people wrote by hand, and a typo'd key is
 * better carried along than a blocked CLI.
 */
const LegacySchema = z
  .object({
    defaults: z
      .object({
        git: z
          .object({
            user: z
              .object({
                name: z.string().nullish(),
                email: z.string().nullish(),
              })
              .nullish(),
          })
          .nullish(),
        features: z
          .record(
            z.string(),
            z
              .record(
                z.string(),
                z.union([z.string(), z.number(), z.boolean()]).nullish(),
              )
              .nullish(),
          )
          .nullish(),
      })
      .nullish(),
    routing: z.object({ hostPort: z.number().nullish() }).nullish(),
    upgrade: z.object({ staleDays: z.number().nullish() }).nullish(),
  })
  .passthrough();

type Legacy = z.infer<typeof LegacySchema>;

interface Move {
  /** Where the value was in the yml, for the message. */
  from: string;
  key: string;
  value: string;
}

interface ManualOption {
  ref: string;
  option: string;
  value: string;
}

/**
 * Migrate the legacy yml if there is one. Returns the message for the
 * builder, or `undefined` when there was nothing to migrate.
 */
export async function migrateGlobalYml(
  home: string,
): Promise<string | undefined> {
  const ymlPath = path.join(home, LEGACY_GLOBAL_YML);
  if (!existsSync(ymlPath)) return undefined;

  const legacy = parseLegacy(await fs.readFile(ymlPath, 'utf8'), ymlPath);
  const { moves, manual } = await planMoves(legacy);

  const envPath = globalEnvPath(home);
  const moved: Move[] = [];
  const kept: Move[] = [];
  if (moves.length > 0) {
    await ensureGlobalEnv(envPath);
    const current = parseEnvFile(await fs.readFile(envPath, 'utf8'));
    for (const move of moves) {
      const existing = current[move.key]?.trim() ?? '';
      if (existing !== '') {
        if (existing !== move.value) kept.push(move);
        continue;
      }
      await setEnvVarRef(envPath, 'monoceros-config', move.key, move.value);
      moved.push(move);
    }
  }

  const migratedPath = ymlPath + MIGRATED_SUFFIX;
  await fs.rename(ymlPath, migratedPath);
  return formatNotice({ moved, kept, manual, envPath, migratedPath });
}

function parseLegacy(text: string, ymlPath: string): Legacy {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    throw new Error(
      `Could not migrate ${prettyPath(ymlPath)}: ${doc.errors[0]!.message}\n` +
        `Monoceros no longer reads this file. Fix it so its values can move into ` +
        `monoceros-config.env, or delete it.`,
    );
  }
  const result = LegacySchema.safeParse(doc.toJS() ?? {});
  if (!result.success) {
    const issue = result.error.issues[0]!;
    throw new Error(
      `Could not migrate ${prettyPath(ymlPath)}: ${issue.path.join('.') || '(root)'}: ${issue.message}\n` +
        `Monoceros no longer reads this file. Fix it so its values can move into ` +
        `monoceros-config.env, or delete it.`,
    );
  }
  return result.data;
}

async function planMoves(
  legacy: Legacy,
): Promise<{ moves: Move[]; manual: ManualOption[] }> {
  const moves: Move[] = [];
  const manual: ManualOption[] = [];

  const hostPort = legacy.routing?.hostPort;
  if (typeof hostPort === 'number' && hostPort !== LEGACY_DEFAULT_HOST_PORT) {
    moves.push({
      from: 'routing.hostPort',
      key: 'MONOCEROS_HOST_PORT',
      value: String(hostPort),
    });
  }
  const staleDays = legacy.upgrade?.staleDays;
  if (
    typeof staleDays === 'number' &&
    staleDays !== DEFAULT_UPGRADE_STALE_DAYS
  ) {
    moves.push({
      from: 'upgrade.staleDays',
      key: 'MONOCEROS_UPGRADE_STALE_DAYS',
      value: String(staleDays),
    });
  }
  const user = legacy.defaults?.git?.user;
  if (user?.name?.trim()) {
    moves.push({
      from: 'defaults.git.user.name',
      key: 'GIT_USER_NAME',
      value: user.name.trim(),
    });
  }
  if (user?.email?.trim()) {
    moves.push({
      from: 'defaults.git.user.email',
      key: 'GIT_USER_EMAIL',
      value: user.email.trim(),
    });
  }

  const features = legacy.defaults?.features ?? {};
  const refs = Object.keys(features);
  if (refs.length > 0) {
    const catalog = await loadDescriptorCatalog();
    for (const ref of refs) {
      const id = matchMonocerosFeature(ref)?.name;
      const specs = id ? catalog.get(id)?.descriptor.options : undefined;
      for (const [option, raw] of Object.entries(features[ref] ?? {})) {
        if (raw === null || raw === undefined || String(raw).trim() === '') {
          continue;
        }
        const value = String(raw);
        if (specs?.[option]?.surface === 'env') {
          moves.push({
            from: `defaults.features.${id}.${option}`,
            key: featureOptionVarName(ref, option),
            value,
          });
        } else {
          manual.push({ ref, option, value });
        }
      }
    }
  }
  return { moves, manual };
}

/** Create the global env from its template when the builder has none yet. */
async function ensureGlobalEnv(envPath: string): Promise<void> {
  if (existsSync(envPath)) return;
  let content = '';
  try {
    content = await fs.readFile(
      path.join(workbenchRoot(), 'templates', 'monoceros-config.sample.env'),
      'utf8',
    );
  } catch {
    // No template reachable: an empty file is still a valid env file.
  }
  await fs.mkdir(path.dirname(envPath), { recursive: true });
  await fs.writeFile(envPath, content);
}

function formatNotice(r: {
  moved: Move[];
  kept: Move[];
  manual: ManualOption[];
  envPath: string;
  migratedPath: string;
}): string {
  const env = prettyPath(r.envPath);
  const lines: string[] = [
    `${LEGACY_GLOBAL_YML} is no longer used. The machine-wide settings are in ${env} now.`,
  ];
  if (r.moved.length > 0) {
    lines.push('Moved there:');
    for (const m of r.moved) lines.push(`  ${m.from} -> ${m.key}`);
  }
  if (r.kept.length > 0) {
    lines.push('Already set there, so the value from the yml was dropped:');
    for (const m of r.kept) lines.push(`  ${m.key} (from ${m.from})`);
  }
  if (r.manual.length > 0) {
    lines.push(
      'These feature options have no place in the env. Add them to the feature entry in each workbench yml that should keep them:',
    );
    for (const m of r.manual) {
      lines.push(`  ${m.ref}: ${m.option}: ${m.value}`);
    }
  }
  if (r.moved.length === 0 && r.kept.length === 0 && r.manual.length === 0) {
    lines.push('It held only default values, so nothing had to move.');
  }
  lines.push(
    `The old file is now ${prettyPath(r.migratedPath)}. You can delete it.`,
  );
  return lines.join('\n');
}
