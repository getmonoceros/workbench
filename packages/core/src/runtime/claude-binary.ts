import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/**
 * Resolves the platform-specific `claude` native binary that ships
 * with the Agent SDK.
 *
 * Why we need this: the SDK's built-in resolution (`F5()` in
 * `sdk.mjs` of @anthropic-ai/claude-agent-sdk@0.2.138) tries the
 * `*-musl` variant before `*-glibc` on linux:
 *
 *     linux ? [
 *       `@anthropic-ai/claude-agent-sdk-linux-${arch}-musl`,   // musl FIRST
 *       `@anthropic-ai/claude-agent-sdk-linux-${arch}`,        // glibc fallback
 *     ] : [...]
 *
 * If pnpm has installed both libc variants (our case — we want the
 * workbench bind-mount to serve any future linux runtime), the SDK
 * picks musl. On a Debian-bookworm-based glibc container the kernel
 * then fails to load `/lib/ld-musl-aarch64.so.1` and the SDK reports
 * "Claude Code native binary not found".
 *
 * Resolution strategy: locate the main SDK package via
 * `require.resolve('@anthropic-ai/claude-agent-sdk/package.json')`
 * (which IS resolvable because @monoceros/core depends on it
 * directly), then navigate up to the `@anthropic-ai/` directory and
 * pick the right sibling platform package by filename. We use
 * `existsSync` instead of `require.resolve` for the binary itself
 * because the platform packages aren't always importable through
 * pnpm's hoisted layout — but they ARE always present as siblings
 * of the main SDK package in `.pnpm/.../@anthropic-ai/`.
 */
export function resolveClaudeBinary(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  isGlibc: () => boolean = isLinuxGlibc,
): string | undefined {
  const requireResolve = createRequire(import.meta.url).resolve;

  let sdkMain: string;
  try {
    sdkMain = requireResolve('@anthropic-ai/claude-agent-sdk');
  } catch {
    return undefined;
  }

  // sdkMain      = .../@anthropic-ai/claude-agent-sdk/sdk.mjs
  // anthropicDir = .../@anthropic-ai/
  // (package.json subpath is not exported, so we go through the entry file)
  const anthropicDir = dirname(dirname(sdkMain));

  const ext = platform === 'win32' ? '.exe' : '';
  let candidates: string[];
  if (platform === 'linux') {
    candidates = isGlibc()
      ? [
          `claude-agent-sdk-linux-${arch}`,
          `claude-agent-sdk-linux-${arch}-musl`,
        ]
      : [
          `claude-agent-sdk-linux-${arch}-musl`,
          `claude-agent-sdk-linux-${arch}`,
        ];
  } else {
    candidates = [`claude-agent-sdk-${platform}-${arch}`];
  }

  for (const pkg of candidates) {
    const binary = join(anthropicDir, pkg, `claude${ext}`);
    if (existsSync(binary)) return binary;
  }
  return undefined;
}

/**
 * Detects whether the running linux process is on glibc (vs musl).
 * `process.report.getReport().header.glibcVersionRuntime` is the
 * standard signal — populated with a version string on glibc,
 * empty/undefined on musl (Alpine, etc.).
 */
export function isLinuxGlibc(): boolean {
  try {
    const report = process.report.getReport() as {
      header?: { glibcVersionRuntime?: string };
    };
    const glibc = report.header?.glibcVersionRuntime;
    return typeof glibc === 'string' && glibc.length > 0;
  } catch {
    // Older Node or constrained environments: assume glibc (most common).
    return true;
  }
}
