import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';

/**
 * The team repository behind `<MONOCEROS_HOME>/templates/`, as far as
 * `list-components --json` needs it (#146). A team shares its templates by
 * making that folder a clone of one Git repository; whatever is committed
 * there, every colleague gets with a pull. Everything else in the folder (a
 * `my-*` file the repository's `.gitignore` leaves out, a file not committed
 * yet) exists on this machine only.
 */
export interface TemplateRepository {
  /** Absolute paths, under the templates folder, of the files in `HEAD`. */
  committed: ReadonlySet<string>;
  /** `origin` as an HTTPS URL without credentials, when there is one. */
  url?: string;
}

/**
 * Read the repository, or `undefined` when the folder is not the top of one.
 * A folder that merely sits inside another repository (the dev home
 * `.local/templates/` in the workbench checkout) is not a team repository:
 * its files and its remote belong to something else. A missing `git` reads
 * the same as no repository.
 */
export function readTemplateRepository(
  templatesDir: string,
): TemplateRepository | undefined {
  const top = git(templatesDir, ['rev-parse', '--show-toplevel'])?.trim();
  if (!top || !samePath(top, templatesDir)) return undefined;
  // No commit yet: `HEAD` does not resolve and nothing is shared.
  const files = git(templatesDir, [
    'ls-tree',
    '-r',
    '-z',
    '--name-only',
    'HEAD',
  ]);
  const committed = new Set(
    (files ?? '')
      .split('\0')
      .filter(Boolean)
      .map((f) => path.join(templatesDir, f)),
  );
  const url = publicRemoteUrl(
    git(templatesDir, ['remote', 'get-url', 'origin'])?.trim() ?? '',
  );
  return { committed, ...(url ? { url } : {}) };
}

/** `team` for a file the repository has committed, `personal` for any other. */
export function templateSource(
  file: string,
  repository: TemplateRepository | undefined,
): 'team' | 'personal' {
  return repository?.committed.has(file) ? 'team' : 'personal';
}

/**
 * The remote as it may leave the machine: an HTTPS URL with the user-info part
 * dropped, because a clone URL often carries a token
 * (`https://<token>@github.com/…`) and this one goes to the clipboard and from
 * there onto a shared page. Any other form (`git@host:…`) is left out:
 * Monoceros clones over HTTPS only.
 */
export function publicRemoteUrl(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  url.username = '';
  url.password = '';
  return url.toString();
}

function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    });
  } catch {
    return undefined;
  }
}

function samePath(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}
