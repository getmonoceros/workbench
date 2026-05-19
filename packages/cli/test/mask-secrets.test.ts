import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  createSecretMaskStream,
  maskSecrets,
} from '../src/util/mask-secrets.js';

describe('maskSecrets', () => {
  it('masks the middle of an Atlassian API token', () => {
    const input =
      'apiToken: ATATT3xFfGF0iV6FZbE9LkCdoMOnGdEU2gT3bxYfHasSomeLongTail123';
    const out = maskSecrets(input);
    expect(out).toMatch(/ATATT…[A-Za-z0-9]{6}/);
    expect(out).not.toContain('xFfGF0iV6FZbE9LkCd');
  });

  it('masks a Bitbucket app password', () => {
    const input = 'TWG_BBC_TOKEN=ATBBabcdefghijklmnopqrstuvwxyz12345678';
    const out = maskSecrets(input);
    expect(out).toMatch(/ATBBa…[A-Za-z0-9]{6}/);
    expect(out).not.toContain('ghijklmnop');
  });

  it('masks a classic GitHub PAT', () => {
    const input = 'GH_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz12345678ABCD';
    const out = maskSecrets(input);
    expect(out).toMatch(/ghp_a…[A-Za-z0-9]{6}/);
    expect(out).not.toContain('mnopqrstuv');
  });

  it('masks a GitHub fine-grained PAT', () => {
    const input =
      'GH_TOKEN=github_pat_11AAAABBB_long_token_value_with_underscores_abc';
    const out = maskSecrets(input);
    expect(out).toContain('githu…');
    expect(out).not.toContain('long_token_value');
  });

  it('masks an Anthropic API key', () => {
    const input = 'ANTHROPIC_API_KEY=sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz';
    const out = maskSecrets(input);
    expect(out).toContain('sk-an…');
    expect(out).not.toContain('AbCdEfGhIj');
  });

  it('leaves short uppercase words alone', () => {
    // ATATT prefix is real but the token-shape regex demands a long
    // tail. A bare "ATATT3xFf" without much after isn't matched.
    const input = 'ENV: PATH MUST NOT BE TOUCHED';
    expect(maskSecrets(input)).toBe(input);
  });

  it('idempotent on an already-masked string', () => {
    const masked = 'apiToken: ATATT…abcdef';
    expect(maskSecrets(masked)).toBe(masked);
  });

  it('masks several different secrets in one input', () => {
    const input = [
      'GH_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz12345678ABCD',
      'apiToken: ATATT3xFfGF0iV6FZbE9LkCdoMOnGdEU2gT3bxYfHasSomeLongTail123',
      'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz',
    ].join('\n');
    const out = maskSecrets(input);
    expect(out).not.toContain('mnopqrstuv');
    expect(out).not.toContain('xFfGF0iV6FZbE9LkCd');
    expect(out).not.toContain('AbCdEfGhIj');
  });
});

describe('createSecretMaskStream', () => {
  async function pipeThrough(input: string): Promise<string> {
    const transform = createSecretMaskStream();
    const out: string[] = [];
    transform.on('data', (chunk: Buffer | string) => {
      out.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    });
    Readable.from([input]).pipe(transform);
    await new Promise<void>((resolve) => transform.on('end', resolve));
    return out.join('');
  }

  it('masks tokens that arrive in one chunk', async () => {
    const out = await pipeThrough(
      'feature options: apiToken=ATATT3xFfGF0iV6FZbE9LkCdoMOnGdEU2gT3bxYfHaA\nnext line\n',
    );
    expect(out).toContain('ATATT…');
    expect(out).not.toContain('xFfGF0iV6FZbE9LkCd');
    expect(out).toContain('next line');
  });

  it('flushes the trailing partial line through the masker', async () => {
    // Last line has no terminating newline. The flush hook handles
    // it so we still see masked output for that part.
    const out = await pipeThrough(
      'line one\nGH_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz12345678ABCD',
    );
    expect(out).toContain('line one');
    expect(out).toContain('ghp_a…');
    expect(out).not.toContain('lmnopqrst');
  });

  it('passes non-secret text through unchanged', async () => {
    const out = await pipeThrough(
      'ordinary build log\n#3 DONE 0.1s\nstep complete\n',
    );
    expect(out).toBe('ordinary build log\n#3 DONE 0.1s\nstep complete\n');
  });
});
