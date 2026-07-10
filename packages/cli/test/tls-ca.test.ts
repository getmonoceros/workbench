import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import forge from 'node-forge';
import { ensureCa, ensureLeafCert } from '../src/tls/ca.js';

let home: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'monoceros-tls-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('ensureCa', () => {
  it('creates a CA cert + key once and reuses them on the next call', async () => {
    const first = await ensureCa(home);
    expect(first.certPath).toBe(path.join(home, 'ca', 'rootCA.pem'));

    const certPem = await readFile(first.certPath, 'utf8');
    const cert = forge.pki.certificateFromPem(certPem);
    expect(cert.getExtension('basicConstraints')).toMatchObject({ cA: true });
    expect(cert.subject.getField('CN').value).toBe('Monoceros Local CA');

    // The private key is written with owner-only permissions.
    const mode = (await stat(path.join(home, 'ca', 'rootCA-key.pem'))).mode;
    expect(mode & 0o777).toBe(0o600);

    // Reuse: same bytes, not regenerated (trust granted to it must survive).
    const second = await ensureCa(home);
    expect(await readFile(second.certPath, 'utf8')).toBe(certPem);
  });
});

describe('ensureLeafCert', () => {
  it('issues a leaf signed by the CA covering DNS + IP SANs', async () => {
    const res = await ensureLeafCert({
      sans: ['host.local', '192.168.1.10', 'localhost', '127.0.0.1'],
      monocerosHome: home,
    });
    expect(res.certFile).toBe('leaf.pem');
    expect(res.caCertPath).toBe(path.join(home, 'ca', 'rootCA.pem'));

    const leaf = forge.pki.certificateFromPem(
      await readFile(path.join(res.certDir, res.certFile), 'utf8'),
    );
    const ca = forge.pki.certificateFromPem(
      await readFile(res.caCertPath, 'utf8'),
    );

    // Signed by our CA.
    expect(ca.verify(leaf)).toBe(true);

    // SANs: DNS entries as type 2, IPs as type 7.
    const san = leaf.getExtension('subjectAltName') as {
      altNames: Array<{ type: number; value?: string; ip?: string }>;
    };
    const dns = san.altNames.filter((a) => a.type === 2).map((a) => a.value);
    const ips = san.altNames.filter((a) => a.type === 7).map((a) => a.ip);
    expect(dns).toContain('host.local');
    expect(dns).toContain('localhost');
    expect(ips).toContain('192.168.1.10');
    expect(ips).toContain('127.0.0.1');

    // Leaf validity stays under the 398-day browser cap.
    const days =
      (leaf.validity.notAfter.getTime() - leaf.validity.notBefore.getTime()) /
      (24 * 60 * 60 * 1000);
    expect(days).toBeLessThanOrEqual(398);
  });

  it('reuses the cached leaf for the same SAN set, reissues when it changes', async () => {
    const a = await ensureLeafCert({
      sans: ['host.local', '192.168.1.10'],
      monocerosHome: home,
    });
    const leafPath = path.join(a.certDir, a.certFile);
    const pem1 = await readFile(leafPath, 'utf8');

    // Same SANs (order-independent) → identical cert, no reissue.
    const b = await ensureLeafCert({
      sans: ['192.168.1.10', 'host.local'],
      monocerosHome: home,
    });
    expect(await readFile(path.join(b.certDir, b.certFile), 'utf8')).toBe(pem1);

    // Changed SANs (IP moved) → new cert.
    const c = await ensureLeafCert({
      sans: ['host.local', '192.168.1.20'],
      monocerosHome: home,
    });
    expect(await readFile(path.join(c.certDir, c.certFile), 'utf8')).not.toBe(
      pem1,
    );
  });

  it('reissues when the cached leaf is near expiry', async () => {
    const a = await ensureLeafCert({
      sans: ['host.local'],
      monocerosHome: home,
    });
    const leafPath = path.join(a.certDir, a.certFile);
    const pem1 = await readFile(leafPath, 'utf8');

    // Force the metadata to look nearly expired.
    const metaPath = path.join(home, 'certs', 'leaf.json');
    await writeFile(
      metaPath,
      JSON.stringify({
        sans: ['host.local'],
        notAfter: new Date(Date.now() + 60 * 1000).toISOString(),
      }),
    );

    const b = await ensureLeafCert({
      sans: ['host.local'],
      monocerosHome: home,
    });
    expect(await readFile(path.join(b.certDir, b.certFile), 'utf8')).not.toBe(
      pem1,
    );
  });
});
