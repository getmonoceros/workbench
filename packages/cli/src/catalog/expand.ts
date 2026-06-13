import type { DescriptorCategory } from './descriptor.js';
import type { CatalogComponent } from './load.js';

/**
 * Expand the descriptor catalog into the flat list of *selectable*
 * components the CLI exposes (the `--with-*` / yml / list-components surface).
 * One base entry per descriptor (keyed by its selector `name`, default `id`),
 * plus one entry per `presets` key as `<name>/<presetKey>` (e.g.
 * `atlassian/twg`). This reproduces the old component-template catalog where
 * each preset was a separate file.
 */

export interface SelectableComponent {
  /** CLI/yml selector, e.g. `claude`, `postgres`, `atlassian/twg`. */
  name: string;
  category: DescriptorCategory;
  displayName: string;
  description: string;
  /** Canonical descriptor id this entry resolves to (e.g. `claude-code`). */
  componentId: string;
  /** Option overrides for a preset entry; absent on the base entry. */
  presetOptions?: Record<string, string | boolean | number>;
}

export function expandSelectable(
  catalog: Map<string, CatalogComponent>,
): Map<string, SelectableComponent> {
  const out = new Map<string, SelectableComponent>();
  const add = (entry: SelectableComponent): void => {
    if (out.has(entry.name)) {
      throw new Error(
        `Duplicate selectable component name '${entry.name}' (from descriptor '${entry.componentId}').`,
      );
    }
    out.set(entry.name, entry);
  };
  for (const { descriptor: d } of catalog.values()) {
    const selector = d.name ?? d.id;
    add({
      name: selector,
      category: d.category,
      displayName: d.displayName,
      description: d.description,
      componentId: d.id,
    });
    for (const [presetKey, overrides] of Object.entries(d.presets ?? {})) {
      add({
        name: `${selector}/${presetKey}`,
        category: d.category,
        displayName: `${d.displayName} (${presetKey})`,
        description: d.description,
        componentId: d.id,
        presetOptions: overrides,
      });
    }
  }
  return out;
}
