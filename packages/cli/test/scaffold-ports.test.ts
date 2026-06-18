import { describe, expect, it } from 'vitest';
import {
  buildComposeYaml,
  buildDevcontainerJson,
  ideStateVolumes,
  normalizeOptions,
} from '../src/create/scaffold.js';
import { resolveService, expandCuratedService } from '../src/create/catalog.js';
import type { CreateOptions } from '../src/create/types.js';

const base: CreateOptions = {
  name: 'sandbox',
  languages: [],
  services: [],
};

describe('deferred service start (ADR 0025)', () => {
  it('excludes a deferred service from runServices, keeps eager ones', () => {
    const dc = buildDevcontainerJson({
      ...base,
      runtimeVersion: '1.3.2',
      services: [
        resolveService(expandCuratedService('postgres')),
        resolveService(expandCuratedService('keycloak')),
      ],
    }) as { runServices?: string[] };
    expect(dc.runServices).toEqual(['postgres']);
  });

  it('omits runServices entirely when every service is deferred', () => {
    const dc = buildDevcontainerJson({
      ...base,
      runtimeVersion: '1.3.2',
      services: [resolveService(expandCuratedService('keycloak'))],
    }) as { runServices?: string[] };
    expect(dc.runServices).toBeUndefined();
  });

  it('still defines the deferred service (with its command) in compose.yaml', () => {
    const yaml = buildComposeYaml({
      ...base,
      runtimeVersion: '1.3.2',
      services: [resolveService(expandCuratedService('keycloak'))],
    });
    expect(yaml).toContain('keycloak:');
    expect(yaml).toContain('command: "start-dev --import-realm"');
  });
});

describe('VS Code IDE-state volumes (ADR 0015)', () => {
  it('names unique extensions + userdata volumes per container, per IDE', () => {
    expect(ideStateVolumes('demo')).toEqual([
      {
        volume: 'monoceros-demo-vscode-extensions',
        target: '/home/node/.vscode-server/extensions',
        minRuntime: '1.1.0',
      },
      {
        volume: 'monoceros-demo-vscode-userdata',
        target: '/home/node/.vscode-server/data/User',
        minRuntime: '1.1.0',
      },
      {
        volume: 'monoceros-demo-vscodium-extensions',
        target: '/home/node/.vscodium-server/extensions',
        minRuntime: '1.2.0',
      },
      {
        volume: 'monoceros-demo-vscodium-userdata',
        target: '/home/node/.vscodium-server/data/User',
        minRuntime: '1.2.0',
      },
      {
        volume: 'monoceros-jetbrains-dist',
        target: '/home/node/.cache/JetBrains/RemoteDev/dist',
        minRuntime: '1.3.2',
        shared: true,
      },
      {
        volume: 'monoceros-demo-jetbrains-cache',
        target: '/home/node/.cache/JetBrains',
        minRuntime: '1.3.0',
      },
      {
        volume: 'monoceros-demo-jetbrains-config',
        target: '/home/node/.config/JetBrains',
        minRuntime: '1.3.0',
      },
      {
        volume: 'monoceros-demo-jetbrains-data',
        target: '/home/node/.local/share/JetBrains',
        minRuntime: '1.3.0',
      },
    ]);
  });

  it('per-container JetBrains volumes at 1.3.0, shared dist only from 1.3.2', () => {
    // 1.3.0/1.3.1: per-container JetBrains volumes mount, but NOT the
    // shared dist (the image only pre-creates .../RemoteDev/dist at 1.3.2).
    const at130 = buildDevcontainerJson({ ...base, runtimeVersion: '1.3.0' });
    if (!('runArgs' in at130)) throw new Error('expected image-mode shape');
    const m130 = (at130.mounts ?? []).join('\n');
    expect(m130).toContain(
      'source=monoceros-sandbox-jetbrains-cache,target=/home/node/.cache/JetBrains,type=volume',
    );
    expect(m130).toContain('source=monoceros-sandbox-jetbrains-config,');
    expect(m130).toContain('source=monoceros-sandbox-jetbrains-data,');
    expect(m130).not.toContain('monoceros-jetbrains-dist');

    // 1.3.2: only the backend DISTRIBUTION is shared (no `<name>`, nested
    // at RemoteDev/dist); session state stays in the per-container cache.
    const at132 = buildDevcontainerJson({ ...base, runtimeVersion: '1.3.2' });
    if (!('runArgs' in at132)) throw new Error('expected image-mode shape');
    const m132 = (at132.mounts ?? []).join('\n');
    expect(m132).toContain(
      'source=monoceros-jetbrains-dist,target=/home/node/.cache/JetBrains/RemoteDev/dist,type=volume',
    );
    expect(m132).toContain(
      'source=monoceros-sandbox-jetbrains-cache,target=/home/node/.cache/JetBrains,type=volume',
    );

    // Gated: nothing JetBrains at 1.2.0.
    const at120 = buildDevcontainerJson({ ...base, runtimeVersion: '1.2.0' });
    if (!('runArgs' in at120)) throw new Error('expected image-mode shape');
    expect((at120.mounts ?? []).join('\n')).not.toContain('JetBrains');
  });

  it('gates the VS Codium volumes on runtime 1.2.0 (not the 1.1.0 VS Code floor)', () => {
    // 1.1.0: VS Code volumes mount, VS Codium ones do not (the image
    // doesn't pre-create node-owned ~/.vscodium-server until 1.2.0).
    const at110 = buildDevcontainerJson({ ...base, runtimeVersion: '1.1.0' });
    if (!('runArgs' in at110)) throw new Error('expected image-mode shape');
    const m110 = (at110.mounts ?? []).join('\n');
    expect(m110).toContain('.vscode-server/extensions');
    expect(m110).not.toContain('.vscodium-server');

    // 1.2.0: both IDEs' volumes mount.
    const at120 = buildDevcontainerJson({ ...base, runtimeVersion: '1.2.0' });
    if (!('runArgs' in at120)) throw new Error('expected image-mode shape');
    const m120 = (at120.mounts ?? []).join('\n');
    expect(m120).toContain(
      'source=monoceros-sandbox-vscodium-extensions,target=/home/node/.vscodium-server/extensions,type=volume',
    );
    expect(m120).toContain(
      'source=monoceros-sandbox-vscodium-userdata,target=/home/node/.vscodium-server/data/User,type=volume',
    );
  });

  it('image-mode mounts both volumes as type=volume on the .vscode-server sub-dirs (pinned runtime)', () => {
    const dc = buildDevcontainerJson({ ...base, runtimeVersion: '1.1.0' });
    if (!('runArgs' in dc)) throw new Error('expected image-mode shape');
    expect(dc.mounts).toContain(
      'source=monoceros-sandbox-vscode-extensions,target=/home/node/.vscode-server/extensions,type=volume',
    );
    expect(dc.mounts).toContain(
      'source=monoceros-sandbox-vscode-userdata,target=/home/node/.vscode-server/data/User,type=volume',
    );
  });

  it('compose-mode references both volumes on workspace and declares them with pinned names (pinned runtime)', () => {
    const yaml = buildComposeYaml({
      ...base,
      runtimeVersion: '1.1.0',
      services: [resolveService(expandCuratedService('postgres'))],
    });
    expect(yaml).toContain(
      '      - monoceros-sandbox-vscode-extensions:/home/node/.vscode-server/extensions',
    );
    expect(yaml).toContain(
      '      - monoceros-sandbox-vscode-userdata:/home/node/.vscode-server/data/User',
    );
    // Top-level declaration with `name:` pinned (no compose project prefix).
    expect(yaml).toMatch(
      /^volumes:\n {2}monoceros-sandbox-vscode-extensions:\n {4}name: monoceros-sandbox-vscode-extensions/m,
    );
  });

  it('emits NO IDE volumes when the runtime is unpinned or below the minimum (capability gate)', () => {
    // Unpinned (legacy) — image-mode.
    const unpinned = buildDevcontainerJson(base);
    if (!('runArgs' in unpinned)) throw new Error('expected image-mode shape');
    expect((unpinned.mounts ?? []).join('\n')).not.toContain('.vscode-server');

    // Below the minimum (1.0.0 < 1.1.0) — compose-mode: no volume refs,
    // and no top-level `volumes:` block at all.
    const yaml = buildComposeYaml({
      ...base,
      runtimeVersion: '1.0.0',
      services: [resolveService(expandCuratedService('postgres'))],
    });
    expect(yaml).not.toContain('.vscode-server');
    expect(yaml).not.toMatch(/^volumes:/m);
  });

  it('resolves the image from the pinned runtimeVersion', () => {
    const dc = buildDevcontainerJson({ ...base, runtimeVersion: '1.1.0' });
    if (!('runArgs' in dc)) throw new Error('expected image-mode shape');
    expect(dc.image).toBe('ghcr.io/getmonoceros/monoceros-runtime:1.1.0');
    // Unpinned falls back to the legacy floating major tag.
    const legacy = buildDevcontainerJson(base);
    if (!('runArgs' in legacy)) throw new Error('expected image-mode shape');
    expect(legacy.image).toBe('ghcr.io/getmonoceros/monoceros-runtime:1');
  });
});

describe('SSH attach postStartCommand (ADR 0022)', () => {
  const SSH_CMD = 'sudo /usr/local/bin/monoceros-sshd-up.sh';

  it('image-mode emits the sshd postStartCommand on a runtime that ships sshd', () => {
    const dc = buildDevcontainerJson({ ...base, runtimeVersion: '1.2.0' });
    if (!('runArgs' in dc)) throw new Error('expected image-mode shape');
    expect(dc.postStartCommand).toBe(SSH_CMD);
  });

  it('compose-mode emits the sshd postStartCommand on a runtime that ships sshd', () => {
    const dc = buildDevcontainerJson({
      ...base,
      runtimeVersion: '1.2.0',
      services: [resolveService(expandCuratedService('postgres'))],
    });
    if ('runArgs' in dc) throw new Error('expected compose-mode shape');
    expect(dc.postStartCommand).toBe(SSH_CMD);
  });

  it('omits the postStartCommand when the runtime is below the minimum or unpinned', () => {
    const old = buildDevcontainerJson({ ...base, runtimeVersion: '1.1.0' });
    expect(old.postStartCommand).toBeUndefined();
    const unpinned = buildDevcontainerJson(base);
    expect(unpinned.postStartCommand).toBeUndefined();
  });
});

describe('deterministic workspace container name (ADR 0022)', () => {
  it('image-mode pins --name=monoceros-<name> in runArgs', () => {
    const dc = buildDevcontainerJson({ ...base, runtimeVersion: '1.2.0' });
    if (!('runArgs' in dc)) throw new Error('expected image-mode shape');
    expect(dc.runArgs).toContain('--name=monoceros-sandbox');
  });

  it('compose-mode sets container_name on the workspace service', () => {
    const yaml = buildComposeYaml({
      ...base,
      runtimeVersion: '1.2.0',
      services: [resolveService(expandCuratedService('postgres'))],
    });
    expect(yaml).toContain('    container_name: monoceros-sandbox');
  });
});

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
      services: [resolveService(expandCuratedService('postgres'))],
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
    const yaml = buildComposeYaml({
      ...base,
      services: [resolveService(expandCuratedService('postgres'))],
    });
    expect(yaml).not.toContain('monoceros-proxy');
    expect(yaml).not.toMatch(/^networks:/m);
  });

  it('attaches the workspace to default + monoceros-proxy with the yml name as alias', () => {
    const yaml = buildComposeYaml({
      ...base,
      services: [resolveService(expandCuratedService('postgres'))],
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
