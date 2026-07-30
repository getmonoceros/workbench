import { describe, expect, it } from 'vitest';
import { buildDevcontainerJson } from '../src/create/scaffold.js';
import type { CreateOptions } from '../src/create/types.js';

/**
 * The proxy backend URL is `http://<name>:<port>`, and that name only
 * resolves because the container joins the `monoceros-proxy` network
 * under a matching alias. Both are docker-run arguments, so they are
 * fixed at container creation — which is exactly why `add-port` has to
 * attach a running container itself (#74). These tests pin the
 * creation half: the args are there when ports are declared, and absent
 * when they are not.
 */

const base: CreateOptions = {
  name: 'sandbox',
  languages: [],
  services: [],
};

function runArgs(opts: CreateOptions): string[] {
  const dc = buildDevcontainerJson(opts);
  return 'runArgs' in dc && Array.isArray(dc.runArgs) ? dc.runArgs : [];
}

describe('image-mode run args: monoceros-proxy network (#74)', () => {
  it('declared ports put the container on the proxy network under its yml name', () => {
    const args = runArgs({ ...base, ports: [3000] });
    expect(args).toContain('--network=monoceros-proxy');
    expect(args).toContain('--network-alias=sandbox');
  });

  it('the alias is the yml name, not the docker container name', () => {
    const args = runArgs({ ...base, name: 'oct', ports: [3000, 5173] });
    // The dynamic config routes to http://oct:3000 — the alias has to
    // match that hostname exactly, without the `monoceros-` prefix.
    expect(args).toContain('--network-alias=oct');
    expect(args).not.toContain('--network-alias=monoceros-oct');
  });

  it('no ports means no proxy network and no alias', () => {
    const args = runArgs(base);
    expect(args.some((a) => a.startsWith('--network='))).toBe(false);
    expect(args.some((a) => a.startsWith('--network-alias='))).toBe(false);
  });

  it('an empty ports array counts as no ports', () => {
    const args = runArgs({ ...base, ports: [] });
    expect(args.some((a) => a.startsWith('--network='))).toBe(false);
  });
});
