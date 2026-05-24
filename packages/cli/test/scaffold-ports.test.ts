import { describe, expect, it } from 'vitest';
import {
  buildComposeYaml,
  buildDevcontainerJson,
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

  it('respects an explicit vscodeAutoForwardPorts=true override', () => {
    const dc = buildDevcontainerJson({
      ...base,
      ports: [3000],
      vscodeAutoForwardPorts: true,
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
