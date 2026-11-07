import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  resolveCopilotPermissionMode,
  writeCopilotSettings,
} from '../src/create/copilot-settings.js';

const COPILOT_REF = 'ghcr.io/getmonoceros/monoceros-features/copilot:1';

describe('resolveCopilotPermissionMode', () => {
  it('maps the claude-code vocabulary onto Copilot values', () => {
    expect(resolveCopilotPermissionMode(undefined)).toBe('assisted');
    expect(resolveCopilotPermissionMode('auto')).toBe('assisted');
    expect(resolveCopilotPermissionMode('ask')).toBe('manual');
    expect(resolveCopilotPermissionMode('bypass')).toBe('allow-all');
  });

  it("passes Copilot's own values through and falls back on a typo", () => {
    expect(resolveCopilotPermissionMode('manual')).toBe('manual');
    expect(resolveCopilotPermissionMode('allow-all')).toBe('allow-all');
    expect(resolveCopilotPermissionMode('assisted')).toBe('assisted');
    expect(resolveCopilotPermissionMode('yolo!')).toBe('assisted');
  });
});

describe('writeCopilotSettings', () => {
  let dir: string;
  const settingsFile = () =>
    path.join(dir, 'home', '.copilot', 'settings.json');
  const configFile = () => path.join(dir, 'home', '.copilot', 'config.json');
  const readJson = async (file: string) =>
    JSON.parse(await fsp.readFile(file, 'utf8')) as Record<string, unknown>;
  const seed = async (file: string, content: string) => {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, content);
  };

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'monoceros-copilot-'));
  });
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('does nothing without the copilot feature', async () => {
    await writeCopilotSettings(dir, 'acme', {
      'ghcr.io/getmonoceros/monoceros-features/claude-code:1': {},
    });
    await expect(fsp.access(settingsFile())).rejects.toThrow();
    await expect(fsp.access(configFile())).rejects.toThrow();
  });

  it('writes the assisted default and trusts the workspace', async () => {
    await writeCopilotSettings(dir, 'acme', { [COPILOT_REF]: {} });
    expect(await readJson(settingsFile())).toEqual({
      defaultPermissionMode: 'assisted',
      storeTokenPlaintext: true,
    });
    expect(await readJson(configFile())).toEqual({
      trustedFolders: ['/workspaces/acme'],
    });
  });

  it('keeps every other key, the login included, and adds the folder once', async () => {
    await seed(settingsFile(), JSON.stringify({ model: 'auto' }));
    await seed(
      configFile(),
      JSON.stringify({ auth: 'kept', trustedFolders: ['/elsewhere'] }),
    );
    const features = { [COPILOT_REF]: { permissionMode: 'ask' } };
    await writeCopilotSettings(dir, 'acme', features);
    await writeCopilotSettings(dir, 'acme', features);
    expect(await readJson(settingsFile())).toEqual({
      model: 'auto',
      defaultPermissionMode: 'manual',
      storeTokenPlaintext: true,
    });
    expect(await readJson(configFile())).toEqual({
      auth: 'kept',
      trustedFolders: ['/elsewhere', '/workspaces/acme'],
    });
  });

  it('keeps the comment header Copilot writes above its config.json', async () => {
    const header =
      '// User settings belong in settings.json.\n// This file is managed automatically.\n';
    await seed(
      configFile(),
      `${header}{\n  "trustedFolders": ["/elsewhere"],\n  "auth": "kept"\n}\n`,
    );
    await writeCopilotSettings(dir, 'acme', { [COPILOT_REF]: {} });
    const text = await fsp.readFile(configFile(), 'utf8');
    expect(text.startsWith(header)).toBe(true);
    expect(JSON.parse(text.slice(header.length))).toEqual({
      trustedFolders: ['/elsewhere', '/workspaces/acme'],
      auth: 'kept',
    });
  });

  it('leaves a file alone that does not parse', async () => {
    const commented = '{\n  // my note\n  "model": "auto"\n}\n';
    await seed(settingsFile(), commented);
    await seed(configFile(), 'not json');
    await writeCopilotSettings(dir, 'acme', { [COPILOT_REF]: {} });
    expect(await fsp.readFile(settingsFile(), 'utf8')).toBe(commented);
    expect(await fsp.readFile(configFile(), 'utf8')).toBe('not json');
  });
});
