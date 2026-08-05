import { describe, expect, it } from 'vitest';
import { parseDescriptorFile } from '../src/catalog/load.js';
import { buildMcpHeaderLines } from '../src/init/mcp-doc.js';

/**
 * The prose the yml carries above an `mcpServers:` entry. It is the only place
 * a builder learns how a connector is authenticated, so an OAuth one has to say
 * so: an entry with no credential otherwise reads like one nobody finished.
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
    expect(text).toMatch(/inside the container/);
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
