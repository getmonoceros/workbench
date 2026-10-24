import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCreateVersion } from '../src/catalog/create-version.js';

// `monoceros create-version <service>` (#141): keeps the current file as
// <id>@<n>.yml, byte for byte, and moves <id>.yml to version n+1.

let home: string;
let services: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'monoceros-create-version-'));
  services = path.join(home, 'templates', 'services');
  await mkdir(services, { recursive: true });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const rabbit = (versionLine: string): string =>
  [
    '# Our message broker. Keep the management UI.',
    'id: rabbitmq',
    'category: service',
    ...(versionLine ? [versionLine] : []),
    'displayName: RabbitMQ',
    "description: 'Message broker with the management UI.'",
    'service:',
    '  image: rabbitmq:4-management',
    '  defaultPort: 5672',
    '',
  ].join('\n');

async function read(name: string): Promise<string> {
  return readFile(path.join(services, name), 'utf8');
}

describe('runCreateVersion', () => {
  it('keeps a file without a version line as @1 and inserts version 2', async () => {
    const before = rabbit('');
    await writeFile(path.join(services, 'rabbitmq.yml'), before);
    const result = await runCreateVersion({
      service: 'rabbitmq',
      monocerosHome: home,
    });
    expect(result).toEqual({
      kept: path.join(services, 'rabbitmq@1.yml'),
      current: path.join(services, 'rabbitmq.yml'),
      version: 2,
    });
    expect(await read('rabbitmq@1.yml')).toBe(before);
    // Everything else, the comment and the quoting included, stays as it was.
    expect(await read('rabbitmq.yml')).toBe(rabbit('version: 2'));
  });

  it('keeps version n and raises an existing version line', async () => {
    const before = rabbit('version: 2');
    await writeFile(path.join(services, 'rabbitmq.yml'), before);
    await writeFile(path.join(services, 'rabbitmq@1.yml'), rabbit(''));
    const result = await runCreateVersion({
      service: 'rabbitmq',
      monocerosHome: home,
    });
    expect(result.version).toBe(3);
    expect(await read('rabbitmq@2.yml')).toBe(before);
    expect(await read('rabbitmq.yml')).toBe(rabbit('version: 3'));
  });

  it('never overwrites a kept version and leaves the current file alone', async () => {
    const before = rabbit('version: 2');
    await writeFile(path.join(services, 'rabbitmq.yml'), before);
    await writeFile(path.join(services, 'rabbitmq@2.yml'), 'kept earlier');
    await expect(
      runCreateVersion({ service: 'rabbitmq', monocerosHome: home }),
    ).rejects.toThrow(
      /rabbitmq@2\.yml already exists, so rabbitmq\.yml was not changed/,
    );
    expect(await read('rabbitmq.yml')).toBe(before);
    expect(await read('rabbitmq@2.yml')).toBe('kept earlier');
  });

  it('refuses a shipped service and says where an own copy would go', async () => {
    await expect(
      runCreateVersion({ service: 'postgres', monocerosHome: home }),
    ).rejects.toThrow(
      /'postgres' is a shipped service: its versions come with the CLI/,
    );
  });

  it('refuses a service that does not exist', async () => {
    await expect(
      runCreateVersion({ service: 'kafka', monocerosHome: home }),
    ).rejects.toThrow(/There is no own service 'kafka'/);
  });

  it('refuses a broken file before it copies anything', async () => {
    await writeFile(path.join(services, 'rabbitmq.yml'), 'id: rabbitmq\n');
    await expect(
      runCreateVersion({ service: 'rabbitmq', monocerosHome: home }),
    ).rejects.toThrow(/Invalid descriptor/);
    await expect(read('rabbitmq@1.yml')).rejects.toThrow();
  });
});
