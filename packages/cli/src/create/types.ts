/**
 * Free-form devcontainer feature options (the value object of the
 * `features: { ... }` map in devcontainer.json). Values are typically
 * strings or booleans, occasionally numbers — whatever the feature's
 * own manifest accepts.
 */
export type FeatureOptions = Record<string, string | number | boolean>;

/**
 * A repo to clone into `projects/<name>/` during post-create.
 * `name` is derived from the URL on add but can be overridden;
 * `branch` is optional (defaults to the repo's default branch).
 */
export interface RepoEntry {
  url: string;
  name: string;
  branch?: string;
}

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
  /**
   * URLs to install scripts that get piped to `bash` during post-create
   * (`bash <(curl -fsSL <url>)`). Run in insertion order, so installs
   * can build on one another. Each URL fetches and executes arbitrary
   * remote shell code — `monoceros add-from-url` warns about that
   * loudly before persisting the entry.
   */
  installUrls?: string[];
  /**
   * Git repositories to clone into `projects/<name>/` during
   * post-create. Cloning is idempotent: if the target directory
   * already exists, the clone step is skipped — local changes survive
   * a rebuild.
   */
  repos?: RepoEntry[];
}
