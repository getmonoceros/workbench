/**
 * Minimal YAML-frontmatter codec for the local FindingsStore. Values
 * are JSON-encoded so we sidestep YAML's quoting and indentation
 * edge cases entirely — any primitive, array or nested object roundtrips
 * losslessly, and the file stays valid YAML for human readers (JSON
 * is a YAML subset).
 *
 * Format:
 *
 *     ---
 *     id: "2026-05-11T20-30-12-456Z-abc-build-fails"
 *     kind: "finding"
 *     severity: "high"
 *     blocking: true
 *     line: 42
 *     tags: ["routing","build"]
 *     ---
 *
 *     Body markdown goes here.
 */

const DELIMITER = '---';

export interface ParsedFile {
  frontmatter: Record<string, unknown>;
  body: string;
}

export function parseFile(content: string): ParsedFile {
  const lines = content.split('\n');
  if (lines[0] !== DELIMITER) {
    throw new Error('frontmatter parse error: missing opening "---"');
  }
  const closeIndex = lines.indexOf(DELIMITER, 1);
  if (closeIndex === -1) {
    throw new Error('frontmatter parse error: missing closing "---"');
  }
  const frontmatter: Record<string, unknown> = {};
  for (let i = 1; i < closeIndex; i++) {
    const line = lines[i]!;
    if (line.trim() === '') continue;
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) {
      throw new Error(`frontmatter parse error on line ${i + 1}: no colon`);
    }
    const key = line.slice(0, colonIndex).trim();
    const rawValue = line.slice(colonIndex + 1).trim();
    if (rawValue === '') {
      frontmatter[key] = null;
      continue;
    }
    try {
      frontmatter[key] = JSON.parse(rawValue);
    } catch {
      throw new Error(
        `frontmatter parse error on line ${i + 1}: value not JSON-parseable: ${rawValue}`,
      );
    }
  }
  // Skip the closing delimiter and one optional blank line before
  // the body — we always write that gap on serialization.
  let bodyStart = closeIndex + 1;
  if (lines[bodyStart] === '') bodyStart++;
  const body = lines.slice(bodyStart).join('\n');
  return { frontmatter, body };
}

export function stringifyFile(
  frontmatter: Record<string, unknown>,
  body: string,
): string {
  const lines: string[] = [DELIMITER];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (value === undefined) continue;
    lines.push(`${key}: ${JSON.stringify(value)}`);
  }
  lines.push(DELIMITER, '', body.endsWith('\n') ? body : `${body}\n`);
  return lines.join('\n');
}
