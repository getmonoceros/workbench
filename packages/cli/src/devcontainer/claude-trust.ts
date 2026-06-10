import { existsSync, promises as fsp } from 'node:fs';
import path from 'node:path';

/**
 * Resolve the container-side working directory `run` will exec in, matching
 * runInContainer's contract: a relative cwd resolves against the workspace
 * folder `/workspaces/<name>`, an absolute cwd is used as-is, and an omitted
 * cwd is the workspace folder itself (devcontainer exec's default).
 */
export function resolveContainerCwd(name: string, cwd?: string): string {
  const workspace = `/workspaces/${name}`;
  if (!cwd) return workspace;
  return path.posix.isAbsolute(cwd) ? cwd : path.posix.join(workspace, cwd);
}

/**
 * Pre-approve Claude Code's two first-run gates for the directory `run` is
 * about to launch in, so the user never faces them — and, more importantly,
 * cannot silently break the Monoceros briefing by declining the external-import
 * prompt (the files it lists, `AGENTS.md` + `.monoceros/commands.md`, ARE the
 * briefing that tells the agent about DATABASE_URL, where to build, and how to
 * keep a server running).
 *
 * Claude stores both approvals per-directory in `~/.claude.json` under
 * `projects[<cwd>]`, keyed by the EXACT cwd — trust does not cascade to
 * subdirectories (anthropics/claude-code#9113). Monoceros bind-mounts that file
 * from `<root>/home/.claude.json`, so we merge the keys host-side for the exact
 * cwd this run uses, right before exec. Seeding at run time (not apply time) is
 * what makes it cover arbitrary later dirs like `projects/<app>`. Only the
 * claude-code feature seeds that file, so its absence means "no Claude here" and
 * there is nothing to do.
 *
 * The keys are Claude-internal and undocumented (there is no supported settings
 * key or env var for this — see the issue above), so this is strictly
 * best-effort: on any parse/IO error we leave the file untouched and Claude
 * falls back to asking, exactly as it does today. It must never break `run`.
 */
export async function preApproveClaudeProject(opts: {
  root: string;
  name: string;
  cwd?: string;
}): Promise<void> {
  const file = path.join(opts.root, 'home', '.claude.json');
  if (!existsSync(file)) return; // no claude-code feature → no file to seed

  try {
    const raw = await fsp.readFile(file, 'utf8');
    const config = raw.trim() ? JSON.parse(raw) : {};
    if (typeof config !== 'object' || config === null) return;

    const dir = resolveContainerCwd(opts.name, opts.cwd);
    if (typeof config.projects !== 'object' || config.projects === null) {
      config.projects = {};
    }
    if (
      typeof config.projects[dir] !== 'object' ||
      config.projects[dir] === null
    ) {
      config.projects[dir] = {};
    }
    const entry = config.projects[dir];

    if (
      entry.hasTrustDialogAccepted === true &&
      entry.hasClaudeMdExternalIncludesApproved === true &&
      entry.hasClaudeMdExternalIncludesWarningShown === true
    ) {
      return; // already approved — no needless rewrite
    }

    entry.hasTrustDialogAccepted = true;
    entry.hasClaudeMdExternalIncludesApproved = true;
    entry.hasClaudeMdExternalIncludesWarningShown = true;
    if (typeof entry.projectOnboardingSeenCount !== 'number') {
      entry.projectOnboardingSeenCount = 1;
    }

    await fsp.writeFile(file, `${JSON.stringify(config, null, 2)}\n`);
  } catch {
    // A malformed or locked .claude.json must not break `run`; Claude will
    // simply ask, as it does today.
  }
}
