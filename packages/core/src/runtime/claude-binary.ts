import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

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
 * picks musl and fails on our Debian-bookworm-based runtime image
 * with a "Claude Code native binary not found" ReferenceError.
 *
 * We sidestep the bug by detecting the libc ourselves and passing
 * the resolved path via `options.pathToClaudeCodeExecutable`.
 */
export function resolveClaudeBinary(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  isGlibc: () => boolean = isLinuxGlibc,
): string | undefined {
  const requireResolve = createRequire(import.meta.url).resolve;
  const ext = platform === 'win32' ? '.exe' : '';

  let candidates: string[];
  if (platform === 'linux') {
    candidates = isGlibc()
      ? [
          `@anthropic-ai/claude-agent-sdk-linux-${arch}/claude`,
          `@anthropic-ai/claude-agent-sdk-linux-${arch}-musl/claude`,
        ]
      : [
          `@anthropic-ai/claude-agent-sdk-linux-${arch}-musl/claude`,
          `@anthropic-ai/claude-agent-sdk-linux-${arch}/claude`,
        ];
  } else {
    candidates = [
      `@anthropic-ai/claude-agent-sdk-${platform}-${arch}/claude${ext}`,
    ];
  }

  for (const candidate of candidates) {
    try {
      return requireResolve(candidate);
    } catch {
      continue;
    }
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

// Expose the resolved module location for diagnostics / smoke tests.
export const RESOLVER_MODULE_URL: string = fileURLToPath(import.meta.url);
