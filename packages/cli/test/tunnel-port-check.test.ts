import { describe, expect, it } from 'vitest';
import { preflightLocalPort } from '../src/tunnel/port-check.js';

describe('preflightLocalPort', () => {
  it('resolves silently when the probe says the port is free', async () => {
    await preflightLocalPort({
      port: 5432,
      address: '127.0.0.1',
      probe: async () => ({ ok: true }),
    });
  });

  it('throws a hint pointing at --local-port on EADDRINUSE', async () => {
    await expect(
      preflightLocalPort({
        port: 5432,
        address: '127.0.0.1',
        probe: async () => ({
          ok: false,
          code: 'EADDRINUSE',
          message: 'in use',
        }),
      }),
    ).rejects.toThrow(
      /Local port 5432 on 127\.0\.0\.1 is already in use[\s\S]+--local-port=5433/,
    );
  });

  it('surfaces unexpected probe errors verbatim', async () => {
    await expect(
      preflightLocalPort({
        port: 5432,
        address: '127.0.0.1',
        probe: async () => ({
          ok: false,
          code: 'EHOSTUNREACH',
          message: 'host unreachable',
        }),
      }),
    ).rejects.toThrow(/Cannot probe local port 5432.*host unreachable/);
  });
});
