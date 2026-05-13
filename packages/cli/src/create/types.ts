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
}
