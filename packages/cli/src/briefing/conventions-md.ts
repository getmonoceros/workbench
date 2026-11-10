import type { AgentsMdInput } from './agents-md.js';

/**
 * Generates `.monoceros/conventions.md` — the "Conventions and pitfalls"
 * chapter, imported by AGENTS.md instead of sitting in it.
 *
 * It used to be 45 lines in the middle of the briefing, where a partial
 * read either caught it or did not. Every rule in here also exists as a
 * one-liner in the briefing's rules block; this file is the long form
 * (the reasoning, the exact paths, the example snippet). Claude Code
 * pulls it in through the `@`-import, OpenCode through its
 * `instructions` list.
 */
export function generateConventionsMd(
  input: Pick<AgentsMdInput, 'containerName'>,
): string {
  const name = input.containerName;
  const lines: string[] = [];

  lines.push('# Conventions and pitfalls');
  lines.push('');
  lines.push(
    'The long form of the rules in `AGENTS.md`. Nothing here contradicts',
    'them; it explains them and names the exact paths.',
  );
  lines.push('');
  lines.push(
    '- **Write everything that goes into the repo in English**: code',
    '  comments, README, docs, commit messages, config comments. The repo',
    '  outlives this conversation and gets readers who do not share the',
    '  language you are chatting in, and a file with two languages in it is',
    '  worse than either. Talk to the user in whatever language they use.',
    '  If they want the project in another language, they will say so, and then',
    '  that language applies to the whole repo, still not mixed per file.',
    `- **Build everything under \`/workspaces/${name}/projects/\`.**`,
    '  That is the project workspace — create new apps and scaffolding there',
    '  (e.g. `projects/<app>/`), and `cd` into it before generating files. Do',
    `  **not** put project files at the workspace root \`/workspaces/${name}\`:`,
    '  it holds Monoceros-managed directories (`.devcontainer/`, `home/`,',
    '  `data/`, `logs/`), not your code. Cloned repos already live at',
    '  `projects/<repo>/` and are git repositories — commit normally.',
    `- **Register new projects in \`${name}.code-workspace\`.** When`,
    '  you scaffold a new project directly under `projects/` (not a clone of a',
    '  repo already listed in the briefing), add it to the VS Code multi-root',
    '  workspace so it shows up in the Explorer. Open',
    `  \`/workspaces/${name}/${name}.code-workspace\``,
    '  and append an entry to the `folders` array, for example',
    '  `{ "path": "projects/<app>", "name": "<app>" }`.',
    '  Add **exactly one** folder entry per directory directly under `projects/`:',
    '  the top-level project directory itself, even when it contains several',
    '  sub-projects (e.g. a `backend/` and a `frontend/`, or a multi-module',
    '  layout). Do **not** register those sub-directories as separate roots — one',
    '  root per top-level project keeps the Explorer readable as more projects',
    '  land in the container. Cloned repos are added there automatically by the',
    '  apply; projects you create yourself are not, so without this step VS Code',
    '  (opened on the host from the workspace file) would not list them.',
    '  Hand-added folder entries survive `monoceros apply`: the apply merges into',
    '  the file, it does not overwrite your edits.',
    '- **Every check has to be able to fail.** For each test or acceptance',
    '  check, name the broken behaviour it would catch and pick the input that',
    '  produces it, then ask whether it would already pass against the code as',
    '  it stands before your change. If it would, it proves nothing. Two traps',
    '  from real runs: a dev server answers `/` with the page shell whether the',
    '  app loads or not, so a 200 there cannot fail (a white page shipped',
    '  behind fifteen green tests because nothing fetched the one module the',
    '  page imported); and input the runtime quietly repairs, like the date',
    '  `2026-02-30`, which JavaScript rolls over to `2026-03-02` and accepts',
    '  (`2026-13-01` is genuinely invalid). For a page, fetch the served HTML,',
    '  then every `<script src>` and `<link href>` it references, and check the',
    '  status and the content type of each.',
    '- **Never state an environment fact you have not checked.** Whether a',
    '  tool exists, which version runs, what listens on a port, what a script',
    '  is called: probe it and quote what came back. A wrong fact gets a',
    '  workaround built around it: a real run told the user to start servers',
    '  by hand because it assumed `monoceros-ctl` was missing, without ever',
    '  running `command -v monoceros-ctl`.',
    '- **Clean up only the test data you created.** Keep the ids your create',
    '  calls return, or give your records a marker (a body that starts with',
    '  `test:`), and delete exactly those. Never empty a table and never delete',
    "  everything a list endpoint returns: the database holds the user's own",
    '  records next to yours. A real run removed its probes by fetching every',
    '  note and deleting each one. The table happened to be empty before;',
    "  otherwise the user's notes would have gone with them.",
    '- You run as the `node` user. `sudo` is available but its effects do',
    '  not persist across rebuilds.',
    '- A bare `EXPOSE` directive has no effect on host reachability. Ports',
    '  the user wants to hit from their browser require',
    `  \`monoceros add-port ${name} <port>\` on the host.`,
    '- If you suggest writing a `.env` file inside a project for local',
    '  values, that is fine — it stays in the workspace. Do not write',
    '  credentials into source-controlled files.',
    `- \`monoceros tunnel ${name} <service>\` on the host opens a TCP`,
    "  tunnel from the user's host to a service in this container. Useful",
    '  to suggest when the user wants to connect a GUI client (psql,',
    '  DataGrip) to one of the services.',
  );
  lines.push('');

  return lines.join('\n');
}
