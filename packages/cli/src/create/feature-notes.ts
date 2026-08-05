import { promises as fs } from 'node:fs';
import path from 'node:path';
import { bold, warnHeading } from '../util/format.js';

/**
 * Feature notes: the channel a feature uses to tell the builder about a decision
 * it made during install.
 *
 * The case that created it: `@forge/cli`'s newer releases exclude specific Node
 * point releases in their `engines` field, one of them exactly the Node the base
 * image ships. npm therefore installs the newest *compatible* version, forge
 * then warns in the container that it is out of date, and nothing anywhere says
 * why. The reason existed only in the container build log, which scrolls past
 * behind the spinner and, on a cached rebuild, is not even produced while the
 * condition still holds.
 *
 * So the note travels on disk instead of in a log: install.sh writes a line into
 * `/usr/local/share/monoceros/notes.d/<feature>.txt` in the image, post-create
 * copies that into the workspace (where it is host-visible), and apply prints
 * it. Post-create runs on every container start, so a cached image still
 * surfaces its notes; and the notes dir is cleared first, so a condition that
 * has gone away stops being reported.
 *
 * Deliberately dumb: plain text, one note per line, no severity and no schema.
 * A note is prose for a human at the end of an apply.
 */

/** Workspace-relative directory holding the copied notes. */
export const NOTES_DIRNAME = path.join('.monoceros', 'notes');

/** Wrap width for a note line, leaving room for the bullet indent. */
const NOTE_WIDTH = 72;

/** Word-wrap to `width`, never splitting a word. */
function wrapText(text: string, width: number): string[] {
  const out: string[] = [];
  let current = '';
  for (const word of text.split(/\s+/).filter((w) => w.length > 0)) {
    if (current.length === 0) {
      current = word;
    } else if (current.length + 1 + word.length <= width) {
      current += ` ${word}`;
    } else {
      out.push(current);
      current = word;
    }
  }
  if (current.length > 0) out.push(current);
  return out.length > 0 ? out : [''];
}

export interface FeatureNote {
  /** Feature the note came from, derived from the file name. */
  feature: string;
  lines: string[];
}

/** In-container path of the notes dir for a container name. */
export function notesDirInContainer(containerName: string): string {
  return `/workspaces/${containerName}/${NOTES_DIRNAME}`;
}

/**
 * Read the notes the last container start left behind. Absent dir, unreadable
 * file and empty content all mean "no notes": this is a reporting nicety and
 * must never be the reason an apply looks broken.
 */
export async function readFeatureNotes(
  targetDir: string,
): Promise<FeatureNote[]> {
  const dir = path.join(targetDir, NOTES_DIRNAME);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: FeatureNote[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith('.txt')) continue;
    let content: string;
    try {
      content = await fs.readFile(path.join(dir, entry), 'utf8');
    } catch {
      continue;
    }
    const lines = content
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (lines.length > 0) {
      out.push({ feature: entry.replace(/\.txt$/, ''), lines });
    }
  }
  return out;
}

/**
 * Render the notes as an end-of-apply warning block, in the same vocabulary as
 * the repo-access warning: `⚠` heading in bold yellow, the source in bold, the
 * note lines as bullets. Same shape on purpose — a builder should not have to
 * learn two ways of being told "nothing is broken, but look at this".
 */
export function formatFeatureNotes(notes: readonly FeatureNote[]): string {
  const lines = warnHeading('Feature notes');
  for (const note of notes) {
    lines.push(bold(`   ${note.feature}`));
    for (const text of note.lines) {
      // A note is prose, often two sentences, so it gets wrapped with a hanging
      // indent under its bullet rather than running off the terminal.
      const wrapped = wrapText(text, NOTE_WIDTH);
      lines.push(`     • ${wrapped[0] ?? ''}`);
      for (const cont of wrapped.slice(1)) lines.push(`       ${cont}`);
    }
    lines.push('');
  }
  // Drop the trailing blank: the caller frames the block with its own newlines.
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}
