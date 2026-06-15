/**
 * Free-form devcontainer feature options (the value object of the
 * `features: { ... }` map in devcontainer.json). Values are typically
 * strings or booleans, occasionally numbers — whatever the feature's
 * own manifest accepts.
 */
export type FeatureOptions = Record<string, string | number | boolean>;

/**
 * A repo to clone into `projects/<path>/` during post-create.
 *
 * `path` is required at this layer (the runtime / scaffold layer):
 * if the yml omits it, the loader fills in the URL-derived default
 * (`https://.../foo.git` → `foo`). The yml schema treats path as
 * optional so the field can be omitted when the URL-derived default
 * is what you want.
 *
 * Subfolders are allowed: `path: "apps/web"` clones into
 * `projects/apps/web/`. Branch selection is intentionally NOT part
 * of this model — `git checkout` inside the running container is
 * the right tool for branch / PR workflows.
 *
 * `gitUser` is an optional per-repo override of the container-level
 * `git.user`. When set, post-create.sh runs
 * `git -C projects/<path> config user.name/email` right after the
 * clone, so this repo's commits go out under the override identity
 * regardless of what's globally configured.
 */
export interface RepoEntry {
  url: string;
  path: string;
  gitUser?: GitUser;
  /**
   * Optional provider hint for the apply-time pre-flight credential
   * check. Required in the yml when the host is not one of the three
   * canonical ones (github.com / gitlab.com / bitbucket.org); the
   * pre-flight rejects the apply with a clear error otherwise. For
   * canonical hosts this is auto-resolved and the field stays empty.
   */
  provider?: 'github' | 'gitlab' | 'bitbucket' | 'gitea';
}

/** Git committer identity used at the container or per-repo level. */
export interface GitUser {
  name: string;
  email: string;
}

/** Healthcheck for a compose service (mirrors `ServiceHealthcheck`). */
export interface ServiceHealthcheck {
  /** Shell-form (string) or exec-form (`["CMD", …]`), as in compose. */
  test: string | string[];
  interval?: string;
  timeout?: string;
  retries?: number;
  startPeriod?: string;
}

/**
 * A fully-resolved backing service, ready for the compose generator.
 * Curated catalog strings and explicit yml objects both normalize to
 * this shape via `resolveService` (create/catalog.ts) — the scaffold
 * never sees the string-vs-object distinction.
 *
 * `volumes` carry raw specs (`data:/path`, `rel/host:/path:ro`); the
 * `data` source shorthand and the host-relative `../` prefix are
 * resolved at compose-generation time in `buildComposeYaml`.
 */
export interface ResolvedService {
  name: string;
  image: string;
  /** In-container listen port — feeds `monoceros tunnel`. Not a host mapping. */
  port?: number;
  env: Record<string, string>;
  volumes: string[];
  /**
   * Compose `user:` (e.g. `"0:0"`). Set for images that run as a fixed
   * non-root uid but must write a host bind-mounted data dir; without it
   * they can't write the apply-created dir on native Linux and exit.
   */
  user?: string;
  healthcheck?: ServiceHealthcheck;
  restart?: string;
  command?: string;
  /**
   * Connection-env templates keyed by logical SUFFIX (`URL`, `HOST`,
   * `PORT`, `USER`, `PASSWORD`, `DB`). At apply, `serviceConnectionEnv`
   * emits them into the workspace as `<UPPER(name)>_<SUFFIX>` (e.g.
   * `POSTGRES_URL`), filling `${host}` (= this service's name), `${port}`
   * and `${<OPTION>}` (from `env`). NOT touched by `.env` interpolation
   * (passes through verbatim), so `${host}`/`${port}` survive to here and
   * a renamed instance stays correct. See ADR 0021.
   */
  connectionEnv?: Record<string, string>;
}

export interface CreateOptions {
  name: string;
  languages: string[];
  /**
   * Per-language feature options from the yml's object form (e.g.
   * `java: { installMaven: false }`), keyed by language name, excluding the
   * version (which stays in the `languages` entry's `:version` suffix). These
   * override the catalog's `defaultOptions` at apply time. Absent when every
   * language entry is the bare string form.
   */
  languageOptions?: Record<string, Record<string, string | number | boolean>>;
  services: ResolvedService[];
  /**
   * Pinned runtime-image version (e.g. `1.1.0`), from the yml's
   * `runtimeVersion`. The scaffold resolves it to a concrete image ref
   * via `resolveRuntimeImage` and gates image-version-dependent config
   * (e.g. the IDE-state volumes) on it. When absent, the scaffold falls
   * back to the legacy floating image and emits no version-gated config;
   * `apply` separately rejects an unpinned yml. See ADR 0017.
   */
  runtimeVersion?: string;
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
  /**
   * Container-internal ports the builder wants to reach from the host.
   * When non-empty:
   *   - the container joins the `monoceros-proxy` docker network,
   *   - the singleton Traefik proxy fronts the ports via Hostname
   *     routing (`<container>.localhost` / `<container>-<port>.localhost`),
   *   - the entries are still written to `forwardPorts` so VS Code's
   *     own port-panel reflects them when the builder opens the
   *     devcontainer through the extension.
   * See ADR 0007.
   */
  ports?: number[];
  /**
   * Whether VS Code's Dev-Containers extension should auto-forward
   * ports on top of Traefik. Default `false` whenever `ports` is
   * non-empty — Traefik is the single source of truth for external
   * URLs and a parallel `localhost:NNNNN` from VS Code would be a
   * confusing second URL for the same app. Builders that want VS
   * Code's panel as the primary entry set this to `true` under
   * `routing.vscodeAutoForward` in the yml. Ignored when `ports` is
   * empty.
   */
  vscodeAutoForward?: boolean;
}
