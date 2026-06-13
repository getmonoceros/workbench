import type { Descriptor, OptionSpec } from './descriptor.js';

/**
 * Generate a devcontainer-feature.json object from a unified component
 * descriptor (ADR 0020). The descriptor is the single source of truth; the
 * devcontainer-feature.json is a build artifact, never hand-edited.
 *
 * This is a pure function (descriptor -> JSON object); writing it to disk and
 * wiring it into the build is a separate step. The output is byte-equivalent
 * to the hand-written manifests it replaces — see `generate-manifest.test.ts`,
 * which diffs the generated object against the current `images/features/*`.
 */

const DEVCONTAINER_FEATURE_SCHEMA =
  'https://raw.githubusercontent.com/devcontainers/spec/main/schemas/devContainerFeature.schema.json';

interface ManifestOption {
  type: OptionSpec['type'];
  proposals?: string[];
  default?: string | boolean | number;
  description?: string;
}

export function descriptorToFeatureManifest(
  descriptor: Descriptor,
): Record<string, unknown> {
  if (descriptor.category !== 'feature' || !descriptor.feature) {
    throw new Error(
      `descriptorToFeatureManifest: '${descriptor.id}' is a ${descriptor.category}, not a feature.`,
    );
  }
  const feat = descriptor.feature;

  const options: Record<string, ManifestOption> = {};
  const optionHints: string[] = [];
  for (const [key, spec] of Object.entries(descriptor.options)) {
    const option: ManifestOption = { type: spec.type };
    if (spec.proposals !== undefined) option.proposals = spec.proposals;
    if (spec.default !== undefined) option.default = spec.default;
    if (spec.description !== undefined) option.description = spec.description;
    options[key] = option;
    // `surface: env` is the old optionHints: an env-backed placeholder the
    // builder fills in. Declaration order is preserved (matches the manifest).
    if (spec.surface === 'env') optionHints.push(key);
  }

  const xMonoceros: Record<string, unknown> = {};
  if (feat.persistentHomePaths && feat.persistentHomePaths.length > 0) {
    xMonoceros.persistentHomePaths = feat.persistentHomePaths;
  }
  if (feat.persistentHomeFiles && feat.persistentHomeFiles.length > 0) {
    xMonoceros.persistentHomeFiles = feat.persistentHomeFiles;
  }
  xMonoceros.optionHints = optionHints;
  xMonoceros.usageNotes = descriptor.usageNotes;
  xMonoceros.briefing = {
    lines: descriptor.briefing.map((line) => ({
      ...(line.whenOption !== undefined ? { whenOption: line.whenOption } : {}),
      text: line.text,
    })),
  };

  const manifest: Record<string, unknown> = {
    $schema: DEVCONTAINER_FEATURE_SCHEMA,
    id: descriptor.id,
    name: descriptor.displayName,
    version: feat.version,
    description: descriptor.description,
  };
  if (descriptor.documentationURL !== undefined) {
    manifest.documentationURL = descriptor.documentationURL;
  }
  if (Object.keys(options).length > 0) {
    manifest.options = options;
  }
  if (feat.vscodeExtensions && feat.vscodeExtensions.length > 0) {
    manifest.customizations = { vscode: { extensions: feat.vscodeExtensions } };
  }
  manifest['x-monoceros'] = xMonoceros;
  return manifest;
}
