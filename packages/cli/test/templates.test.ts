import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config/index.js';

/**
 * Each shipped yml under `templates/yml/` must parse and validate
 * against the schema. Adding a malformed template would surface only
 * when a builder runs `monoceros init <name>` — this test catches it
 * at PR time.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const templatesDir = path.resolve(here, '..', '..', '..', 'templates', 'yml');

async function listTemplateFiles(): Promise<string[]> {
  const entries = await readdir(templatesDir);
  return entries.filter((e) => e.endsWith('.yml')).sort();
}

describe('templates/yml', () => {
  it('has the four initial templates from M2.5 Phase 3', async () => {
    const files = await listTemplateFiles();
    expect(files).toEqual([
      'bare.yml',
      'nodejs-github.yml',
      'python.yml',
      'reference.yml',
    ]);
  });

  it('parses and validates every shipped template', async () => {
    const files = await listTemplateFiles();
    for (const file of files) {
      const full = path.join(templatesDir, file);
      const text = await readFile(full, 'utf8');
      const parsed = parseConfig(text, full);
      // The template's `name` defaults to the template's basename — the
      // init command rewrites this on copy.
      expect(parsed.config.name).toBe(file.replace(/\.yml$/, ''));
      expect(parsed.config.schemaVersion).toBe(1);
    }
  });

  it('every template carries a top-level comment block as inline doc', async () => {
    const files = await listTemplateFiles();
    for (const file of files) {
      const text = await readFile(path.join(templatesDir, file), 'utf8');
      // First non-empty line should be a comment so the template reads
      // as documentation when opened in an editor.
      const firstLine = text.split('\n').find((l) => l.trim().length > 0);
      expect(firstLine, `${file}: first non-empty line`).toMatch(/^#/);
    }
  });
});
