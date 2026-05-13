/**
 * Free-form devcontainer feature options (the value object of the
 * `features: { ... }` map in devcontainer.json). Values are typically
 * strings or booleans, occasionally numbers — whatever the feature's
 * own manifest accepts.
 */
export type FeatureOptions = Record<string, string | number | boolean>;

export interface CreateOptions {
  name: string;
  languages: string[];
  services: string[];
  postgresUrl?: string;
  /**
   * Additional Debian/Ubuntu apt packages to install via the
   * `ghcr.io/devcontainers-contrib/features/apt-packages` devcontainer
   * feature. No curated whitelist — the builder owns the list, invalid
   * names surface as apt errors at container build time.
   */
  aptPackages?: string[];
  /**
   * Custom devcontainer features keyed by feature ref (e.g.
   * `ghcr.io/devcontainers/features/docker-in-docker:2`). The value is
   * the feature's option hash.
   */
  features?: Record<string, FeatureOptions>;
}

export interface StackFile {
  name: string;
  createdAt: string;
  monocerosCliVersion: string;
  languages: string[];
  services: string[];
  externalServices: Record<string, string>;
  /**
   * Optional list of apt packages added via `monoceros add-apt-packages`.
   * Reflected as the apt-packages devcontainer feature in
   * `devcontainer.json` on each regenerate.
   */
  aptPackages?: string[];
  /**
   * Optional map of custom devcontainer features added via
   * `monoceros add-feature`. Keys are feature refs, values are option
   * hashes. Reflected verbatim into `devcontainer.json` → `features`.
   */
  features?: Record<string, FeatureOptions>;
}
