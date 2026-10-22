import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DockerExec, DockerResult } from '../proxy/index.js';
import { gitTokenCascade } from './repo-token.js';

/**
 * Private service images on GHCR (ADR 0064). A package under
 * `ghcr.io/<owner>/…` belongs to the GitHub account `<owner>`, so it is read
 * with the token apply already resolves for `github.com/<owner>`: the same
 * cascade a repo of that owner goes through. The builder sets one token, not
 * a second login for Docker.
 */

const GHCR = 'ghcr.io';

export interface PrivateImage {
  service: string;
  image: string;
  /** The env var the token was read from, for the log line. */
  varName: string;
  token: string;
}

/**
 * The services whose image lives on GHCR and has a token for its owner. An
 * image with no token is left to Docker as before: a public package pulls
 * without one, and Docker's own login still applies.
 */
export function resolvePrivateImages(
  services: readonly { name: string; image: string }[],
  envVars: Record<string, string>,
): PrivateImage[] {
  const out: PrivateImage[] = [];
  for (const s of services) {
    const [host, owner] = s.image.split('/');
    if (host !== GHCR || !owner) continue;
    const varName = gitTokenCascade(
      'github',
      `https://github.com/${owner}`,
    ).find((v) => (envVars[v] ?? '').trim().length > 0);
    if (!varName) continue;
    out.push({
      service: s.name,
      image: s.image,
      varName,
      token: envVars[varName]!.trim(),
    });
  }
  return out;
}

/**
 * Pull one image with its token, through a throwaway Docker config that holds
 * only this credential. Nothing is written to the builder's Docker login, and
 * the token never appears on a command line. The current context's endpoint
 * is passed along, because a fresh config dir knows no contexts and would
 * otherwise talk to the default socket.
 */
export async function pullPrivateImage(
  img: PrivateImage,
  exec: DockerExec,
): Promise<DockerResult> {
  const ctx = await exec([
    'context',
    'inspect',
    '--format',
    '{{.Endpoints.docker.Host}}',
  ]);
  const host = ctx.exitCode === 0 ? ctx.stdout.trim() : '';
  const dir = await mkdtemp(path.join(tmpdir(), 'monoceros-registry-'));
  try {
    const auth = Buffer.from(`monoceros:${img.token}`).toString('base64');
    await writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify({ auths: { [GHCR]: { auth } } }),
      { mode: 0o600 },
    );
    return await exec([
      '--config',
      dir,
      ...(host ? ['--host', host] : []),
      'pull',
      '--quiet',
      img.image,
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
