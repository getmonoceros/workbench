import { describe, expect, it } from 'vitest';
import {
  buildComposeYaml,
  buildDevcontainerJson,
  normalizeOptions,
} from '../src/create/scaffold.js';
import type { CreateOptions } from '../src/create/types.js';

const base: CreateOptions = {
  name: 'sandbox',
  languages: [],
  services: [],
};

describe('buildDevcontainerJson — ports & vscode autoForward', () => {
  it('omits ports, customizations, and the proxy network when no ports declared', () => {
    const dc = buildDevcontainerJson(base);
    if ('runArgs' in dc) {
      expect(dc.forwardPorts).toEqual([]);
      expect(dc.runArgs).not.toContain('--network=monoceros-proxy');
      expect(dc.customizations).toBeUndefined();
    } else {
      throw new Error('expected image-mode shape for a base-only solution');
    }
  });

  // Regression: VS Code's "Open Folder/Workspace in Container" passed
  // the raw host path to the container side when workspaceMount /
  // workspaceFolder were absent, and aborted with "Arbeitsbereich
  // nicht vorhanden". Both fields must be present in image-mode so
  // VS Code knows how the host folder maps into the container.
  it('image-mode pins workspaceMount and workspaceFolder', () => {
    const dc = buildDevcontainerJson({ ...base, ports: [3000] });
    if (!('runArgs' in dc)) throw new Error('expected image-mode shape');
    expect(dc.workspaceFolder).toBe('/workspaces/sandbox');
    expect(dc.workspaceMount).toBe(
      'source=${localWorkspaceFolder},target=/workspaces/sandbox,type=bind,consistency=cached',
    );
  });

  it('image-mode workspaceMount/Folder also present without ports', () => {
    // The fix must NOT be conditional on ports — VS Code needs the
    // mapping regardless of routing.
    const dc = buildDevcontainerJson(base);
    if (!('runArgs' in dc)) throw new Error('expected image-mode shape');
    expect(dc.workspaceFolder).toBe('/workspaces/sandbox');
    expect(dc.workspaceMount).toContain('target=/workspaces/sandbox');
  });

  it('wires runArgs network, alias, forwardPorts, and the autoForward override in image-mode', () => {
    const dc = buildDevcontainerJson({ ...base, ports: [3000, 5173, 6006] });
    if (!('runArgs' in dc)) throw new Error('expected image-mode shape');
    expect(dc.forwardPorts).toEqual([3000, 5173, 6006]);
    expect(dc.runArgs).toContain('--network=monoceros-proxy');
    expect(dc.runArgs).toContain('--network-alias=sandbox');
    expect(
      dc.customizations?.vscode?.settings?.['remote.autoForwardPorts'],
    ).toBe(false);
  });

  it('respects an explicit vscodeAutoForward=true override', () => {
    const dc = buildDevcontainerJson({
      ...base,
      ports: [3000],
      vscodeAutoForward: true,
    });
    if (!('runArgs' in dc)) throw new Error('expected image-mode shape');
    expect(
      dc.customizations?.vscode?.settings?.['remote.autoForwardPorts'],
    ).toBe(true);
  });

  it('uses compose-mode shape when services are present and leaves runArgs alone', () => {
    const dc = buildDevcontainerJson({
      ...base,
      services: ['postgres'],
      ports: [3000],
    });
    if (!('dockerComposeFile' in dc))
      throw new Error('expected compose-mode shape');
    expect(dc.forwardPorts).toEqual([3000]);
    // Compose-mode network membership lives in compose.yaml, not in
    // devcontainer.json — there's no runArgs key here at all.
    expect('runArgs' in dc).toBe(false);
    expect(
      dc.customizations?.vscode?.settings?.['remote.autoForwardPorts'],
    ).toBe(false);
  });
});

describe('buildComposeYaml — ports & networks', () => {
  it('omits the networks block when no ports declared', () => {
    const yaml = buildComposeYaml({ ...base, services: ['postgres'] });
    expect(yaml).not.toContain('monoceros-proxy');
    expect(yaml).not.toMatch(/^networks:/m);
  });

  it('attaches the workspace to default + monoceros-proxy with the yml name as alias', () => {
    const yaml = buildComposeYaml({
      ...base,
      services: ['postgres'],
      ports: [3000],
    });
    expect(yaml).toMatch(/workspace:/);
    // service-level networks list — long form so we can pin the alias
    expect(yaml).toMatch(
      /networks:\s*\n\s+default: \{\}\s*\n\s+monoceros-proxy:\s*\n\s+aliases:\s*\n\s+- sandbox/,
    );
    // top-level networks block with external
    expect(yaml).toMatch(
      /^networks:\s*\n\s+monoceros-proxy:\s*\n\s+external: true/m,
    );
  });
});

describe('normalizeOptions — ports / vscodeAutoForward pass-through', () => {
  // Regression guard: an earlier version of normalizeOptions rebuilt
  // the result object field-by-field and silently dropped `ports` and
  // `vscodeAutoForward`. Apply then took its `removeDynamicConfig`
  // branch right after `add-port` had just written the file. The fix
  // is to plumb both fields through; this test pins it.
  it('preserves ports (deduped, original order)', () => {
    const out = normalizeOptions({
      ...base,
      ports: [3000, 5173, 3000, 6006],
    });
    expect(out.ports).toEqual([3000, 5173, 6006]);
  });

  it('preserves an explicit vscodeAutoForward=true', () => {
    const out = normalizeOptions({
      ...base,
      ports: [3000],
      vscodeAutoForward: true,
    });
    expect(out.vscodeAutoForward).toBe(true);
  });

  it('omits ports when the input has none', () => {
    const out = normalizeOptions(base);
    expect(out.ports).toBeUndefined();
    expect(out.vscodeAutoForward).toBeUndefined();
  });
});
