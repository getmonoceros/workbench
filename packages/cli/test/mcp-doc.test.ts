import { describe, expect, it } from 'vitest';
import { parseDescriptorFile } from '../src/catalog/load.js';
import { buildMcpHeaderLines } from '../src/init/mcp-doc.js';

/**
 * The prose the yml carries above an `mcpServers:` entry: what the connector is
 * and where its page is, plus the sign-in marker, because an entry with no
 * credential otherwise reads like one nobody finished. Everything else the
 * header used to carry belongs on that page, so the tests below also pin what
 * it must NOT say.
 */
function headerFor(yml: string): string {
  const id = /^id:\s*(\S+)$/m.exec(yml)![1]!;
  const { descriptor } = parseDescriptorFile(
    yml,
    `/fake/${id}/component.yml`,
    id,
    'mcp-server',
  );
  return buildMcpHeaderLines(descriptor, 76).join(' ');
}

describe('buildMcpHeaderLines', () => {
  it('sends the builder to the in-container sign-in for an oauth connector', () => {
    const text = headerFor(`
id: linear
category: mcp-server
displayName: Linear
description: 'Issues and projects.'
mcpServer:
  transport: http
  auth: oauth
  url: https://mcp.linear.app/mcp
`);
    expect(text).toMatch(/Signs in interactively, so there is no key to fill/);
    expect(text).toMatch(
      /https:\/\/getmonoceros\.build\/docs\/mcp-servers\/linear\//,
    );
  });

  it('links the connector page rather than restating it', () => {
    const text = headerFor(`
id: linear
category: mcp-server
displayName: Linear
description: 'Issues and projects.'
documentationURL: https://linear.app/docs/mcp
mcpServer:
  transport: http
  auth: oauth
  url: https://mcp.linear.app/mcp
`);
    // The transport, the option table and the sign-in procedure each cost a
    // wrapped paragraph above a one-line entry, and went stale on their own.
    expect(text).not.toMatch(
      /Reached over the network|Runs inside the container/,
    );
    expect(text).not.toMatch(/for further information/);
    expect(text).not.toMatch(/Options:/);
    expect(text.split(' ').length).toBeLessThan(40);
  });

  it('uses the yml selector, not the descriptor id, in the docs link', () => {
    const text = headerFor(`
id: microsoft-learn
name: mslearn
category: mcp-server
displayName: Microsoft Learn
description: 'Microsoft docs.'
mcpServer:
  transport: http
  url: https://learn.microsoft.com/api/mcp
`);
    expect(text).toContain(
      'https://getmonoceros.build/docs/mcp-servers/mslearn/',
    );
  });

  it('says nothing about signing in for a connector with a key', () => {
    const text = headerFor(`
id: context7
category: mcp-server
displayName: Context7
description: 'Current library docs.'
options:
  apiKey:
    type: string
    default: ''
    surface: env
mcpServer:
  transport: http
  url: https://mcp.context7.com/mcp
  headers:
    CONTEXT7_API_KEY: '\${apiKey}'
`);
    expect(text).not.toMatch(/Signs in interactively/);
  });
});
