import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import forge from 'node-forge';
import { monocerosHome as defaultMonocerosHome } from '../config/paths.js';

/**
 * A machine-local certificate authority for `monoceros share` (ADR 0033).
 *
 * `share` forwards app ports to the LAN, but a bare IP / `.local` name over
 * HTTP is an insecure context - which disables `crypto.subtle` (PKCE logins)
 * and Service Workers, so an installable PWA cannot work there. A public CA
 * (Let's Encrypt) will not issue for `.local` / private IPs, and public
 * tunnels route traffic through SaaS. So we terminate TLS in the share sidecar
 * with a leaf cert issued by a CA that lives entirely on this machine.
 *
 * The root CA is created once and reused forever - a device trusts the root a
 * single time. Certificate issuance is pure-JS (node-forge), with no
 * dependency on a host `openssl`/`mkcert` binary, so it works from the
 * single-binary install (ADR 0032).
 */

const CA_DIR = 'ca';
const CA_CERT_FILE = 'rootCA.pem';
const CA_KEY_FILE = 'rootCA-key.pem';

const CERTS_DIR = 'certs';
export const LEAF_CERT_FILE = 'leaf.pem';
export const LEAF_KEY_FILE = 'leaf-key.pem';
const LEAF_META_FILE = 'leaf.json';

/** Root CA validity - long, since installing it on a device is manual. */
const CA_DAYS = 3650;
/**
 * Leaf validity. Browsers (Safari/iOS especially) reject server certs valid
 * for more than 398 days, so we stay comfortably under that and reissue.
 */
const LEAF_DAYS = 397;
/** Reissue a cached leaf once it is within this window of expiring. */
const LEAF_RENEW_BEFORE_MS = 7 * 24 * 60 * 60 * 1000;

const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;

export interface CaResult {
  /** Absolute path to the root CA cert - printed so a device can trust it. */
  certPath: string;
  keyPath: string;
}

export interface ShareTls {
  /** Root CA cert path, for the "trust me once" banner hint. */
  caCertPath: string;
  /** Directory to mount read-only into the socat sidecar. */
  certDir: string;
  /** Leaf cert filename inside `certDir`. */
  certFile: string;
  /** Leaf key filename inside `certDir`. */
  keyFile: string;
}

function homeDir(monocerosHome?: string): string {
  return monocerosHome ?? defaultMonocerosHome();
}

/** DER serials must be positive; a leading `00` keeps the high bit clear. */
function randomSerial(): string {
  return '00' + forge.util.bytesToHex(forge.random.getBytesSync(16));
}

/**
 * The CA's common name carries the host's name so several machines' CAs are
 * distinguishable in a device's trust store (each machine has its own CA - the
 * private key never leaves it). Baked in only when the CA is first created;
 * existing CAs keep their name and stay trusted.
 */
function caCommonName(): string {
  const host = os
    .hostname()
    .replace(/\.local$/, '')
    .trim();
  return host ? `Monoceros Local CA (${host})` : 'Monoceros Local CA';
}

interface LoadedCa {
  cert: forge.pki.Certificate;
  key: forge.pki.rsa.PrivateKey;
  certPath: string;
  keyPath: string;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Load the root CA from `<home>/ca/`, creating it on first use. Idempotent:
 * once the files exist they are reused verbatim so the trust a device granted
 * keeps working.
 */
async function loadOrCreateCa(monocerosHome?: string): Promise<LoadedCa> {
  const dir = path.join(homeDir(monocerosHome), CA_DIR);
  const certPath = path.join(dir, CA_CERT_FILE);
  const keyPath = path.join(dir, CA_KEY_FILE);

  if ((await fileExists(certPath)) && (await fileExists(keyPath))) {
    const cert = forge.pki.certificateFromPem(
      await fs.readFile(certPath, 'utf8'),
    );
    const key = forge.pki.privateKeyFromPem(
      await fs.readFile(keyPath, 'utf8'),
    ) as forge.pki.rsa.PrivateKey;
    return { cert, key, certPath, keyPath };
  }

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = randomSerial();
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(
    cert.validity.notBefore.getTime() + CA_DAYS * 24 * 60 * 60 * 1000,
  );
  const attrs = [{ name: 'commonName', value: caCommonName() }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(certPath, forge.pki.certificateToPem(cert), {
    mode: 0o644,
  });
  await fs.writeFile(keyPath, forge.pki.privateKeyToPem(keys.privateKey), {
    mode: 0o600,
  });
  return { cert, key: keys.privateKey, certPath, keyPath };
}

/** Ensure the root CA exists; returns its paths (for the banner hint). */
export async function ensureCa(monocerosHome?: string): Promise<CaResult> {
  const { certPath, keyPath } = await loadOrCreateCa(monocerosHome);
  return { certPath, keyPath };
}

interface LeafMeta {
  sans: string[];
  notAfter: string;
}

/** Sorted, de-duplicated SAN list so the cache key is order-independent. */
function normalizeSans(sans: string[]): string[] {
  return [...new Set(sans.filter((s) => s.length > 0))].sort();
}

async function readLeafMeta(metaPath: string): Promise<LeafMeta | null> {
  try {
    return JSON.parse(await fs.readFile(metaPath, 'utf8')) as LeafMeta;
  } catch {
    return null;
  }
}

function leafStillGood(meta: LeafMeta | null, sans: string[]): boolean {
  if (!meta) return false;
  if (meta.sans.join(',') !== sans.join(',')) return false;
  const notAfter = new Date(meta.notAfter).getTime();
  if (Number.isNaN(notAfter)) return false;
  return notAfter - Date.now() > LEAF_RENEW_BEFORE_MS;
}

/**
 * Ensure a CA-signed leaf certificate covering `sans` exists under
 * `<home>/certs/`, reissuing only when the SAN set changed or the cached leaf
 * is near expiry. Returns everything the sidecar needs to mount and serve it.
 */
export async function ensureLeafCert(opts: {
  sans: string[];
  monocerosHome?: string;
}): Promise<ShareTls> {
  const sans = normalizeSans(opts.sans);
  const dir = path.join(homeDir(opts.monocerosHome), CERTS_DIR);
  const certPath = path.join(dir, LEAF_CERT_FILE);
  const keyPath = path.join(dir, LEAF_KEY_FILE);
  const metaPath = path.join(dir, LEAF_META_FILE);

  const ca = await loadOrCreateCa(opts.monocerosHome);

  const haveFiles = (await fileExists(certPath)) && (await fileExists(keyPath));
  if (haveFiles && leafStillGood(await readLeafMeta(metaPath), sans)) {
    return {
      caCertPath: ca.certPath,
      certDir: dir,
      certFile: LEAF_CERT_FILE,
      keyFile: LEAF_KEY_FILE,
    };
  }

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = randomSerial();
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(
    cert.validity.notBefore.getTime() + LEAF_DAYS * 24 * 60 * 60 * 1000,
  );
  cert.setSubject([{ name: 'commonName', value: 'monoceros share' }]);
  cert.setIssuer(ca.cert.subject.attributes);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    {
      name: 'keyUsage',
      digitalSignature: true,
      keyEncipherment: true,
      critical: true,
    },
    { name: 'extKeyUsage', serverAuth: true },
    {
      name: 'subjectAltName',
      altNames: sans.map((s) =>
        IPV4_RE.test(s) ? { type: 7, ip: s } : { type: 2, value: s },
      ),
    },
  ]);
  cert.sign(ca.key, forge.md.sha256.create());

  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(certPath, forge.pki.certificateToPem(cert), {
    mode: 0o644,
  });
  await fs.writeFile(keyPath, forge.pki.privateKeyToPem(keys.privateKey), {
    mode: 0o600,
  });
  const meta: LeafMeta = {
    sans,
    notAfter: cert.validity.notAfter.toISOString(),
  };
  await fs.writeFile(metaPath, JSON.stringify(meta), { mode: 0o644 });

  return {
    caCertPath: ca.certPath,
    certDir: dir,
    certFile: LEAF_CERT_FILE,
    keyFile: LEAF_KEY_FILE,
  };
}

/** Compose CA + leaf provisioning - the shape `share` injects and calls. */
export async function provisionShareTls(opts: {
  sans: string[];
  monocerosHome?: string;
}): Promise<ShareTls> {
  return ensureLeafCert(opts);
}

export type ProvisionShareTls = typeof provisionShareTls;
