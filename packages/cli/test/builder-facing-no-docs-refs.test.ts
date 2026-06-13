import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateConfig } from '../src/config/schema.js';
import { runInit } from '../src/init/index.js';
import { buildComposeYaml } from '../src/create/scaffold.js';
import { resolveService, expandCuratedService } from '../src/create/catalog.js';
import { renderDynamicConfig } from '../src/proxy/dynamic.js';
import { formatRootlessNotSupportedError } from '../src/devcontainer/docker-mode.js';
import { formatHostPortHeldError } from '../src/proxy/port-check.js';
import {
  writeDescriptor,
  nodeLanguageDescriptor,
} from './helpers/fake-workbench.js';

/**
 * Builder-facing output (generated yml, compose files, dynamic
 * configs, error messages a builder lands on) MUST NOT reference
 * workbench-internal paths — no `docs/<page>.md`, no `ADR 0007`,
 * no `backlog.md`, no `konzept.md`. The builder doesn't have a
 * workbench checkout when monoceros is installed via npm; those
 * pointers would be broken anchors.
 *
 * Online documentation links (an externally-reachable URL) are
 * allowed and can be added later — this guard only catches the
 * workbench-internal anchors.
 *
 * The bug that prompted this guard: a `# … See ADR 0007.` line
 * landed in the rendered routing block via init's
 * renderActiveRoutingBlock. Source-code review missed it; the
 * builder saw it on first init.
 */

const INTERNAL_DOC_PATTERN =
  /\bADR\s+\d{4}\b|docs\/[a-z][a-z0-9-]+\.md|backlog\.md|konzept\.md/i;

function expectNoInternalDocRefs(label: string, text: string): void {
  const match = text.match(INTERNAL_DOC_PATTERN);
  if (match) {
    throw new Error(
      `Builder-facing output (${label}) contains an internal doc reference: ${JSON.stringify(
        match[0],
      )}\n\nFull text:\n${text}`,
    );
  }
}

describe('no internal docs/ADR refs in builder-facing output', () => {
  let home: string;
  let workbench: string;
  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'monoceros-docs-guard-home-'));
    workbench = await mkdtemp(path.join(tmpdir(), 'monoceros-docs-guard-wb-'));
    await mkdir(path.join(home, 'container-configs'), { recursive: true });
    // Minimal descriptor catalog so runInit's composed mode has something
    // to compose (ADR 0020 layout: components/<category>/<id>/component.yml).
    await writeDescriptor(
      workbench,
      'languages',
      'node',
      nodeLanguageDescriptor(),
    );
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(workbench, { recursive: true, force: true });
  });

  it('init documented-mode yml has no internal doc refs', async () => {
    const result = await runInit({
      name: 'sandbox',
      workbenchRoot: workbench,
      monocerosHome: home,
      logger: { success: () => {}, info: () => {} },
    });
    const text = await readFile(result.configPath, 'utf8');
    expectNoInternalDocRefs('init documented mode', text);
  });

  it('init composed-mode yml with --with-ports and --with-repo has no internal doc refs', async () => {
    const result = await runInit({
      name: 'sandbox',
      languages: ['node'],
      withRepo: ['https://github.com/foo/bar.git'],
      withPorts: [3000, 5173],
      workbenchRoot: workbench,
      monocerosHome: home,
      logger: { success: () => {}, info: () => {} },
    });
    const text = await readFile(result.configPath, 'utf8');
    expectNoInternalDocRefs('init composed mode with ports + repo', text);
  });

  it('compose.yaml has no internal doc refs', () => {
    const yaml = buildComposeYaml({
      name: 'sandbox',
      languages: [],
      services: [resolveService(expandCuratedService('postgres'))],
      ports: [3000],
    });
    expectNoInternalDocRefs('compose.yaml (with ports)', yaml);
  });

  it('Traefik dynamic config has no internal doc refs', () => {
    const dyn = renderDynamicConfig('sandbox', [3000, 5173, 6006]);
    expectNoInternalDocRefs('dynamic config', dyn);
  });

  it('rootless-not-supported error message has no internal doc refs', () => {
    expectNoInternalDocRefs(
      'rootless-not-supported error',
      formatRootlessNotSupportedError(),
    );
  });

  it('host-port-held error message has no internal doc refs', () => {
    expectNoInternalDocRefs(
      'host-port-held (EADDRINUSE)',
      formatHostPortHeldError(80, 'EADDRINUSE', 'in use'),
    );
    expectNoInternalDocRefs(
      'host-port-held (EACCES)',
      formatHostPortHeldError(80, 'EACCES', 'permission denied'),
    );
  });

  it('schema validation error for SSH-style repo URLs has no internal doc refs', () => {
    let captured: Error | undefined;
    try {
      validateConfig({
        schemaVersion: 1,
        name: 'sandbox',
        repos: [{ url: 'git@github.com:foo/bar.git' }],
      });
    } catch (err) {
      captured = err as Error;
    }
    expect(captured).toBeDefined();
    expectNoInternalDocRefs('SSH-URL schema error', captured!.message);
  });
});
