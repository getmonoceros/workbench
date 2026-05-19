import { Transform, type TransformCallback } from 'node:stream';

/**
 * Mask known token-shaped strings in arbitrary text.
 *
 * Devcontainer-cli and docker compose stream the build/up output
 * straight to stdout. They include the feature options (Atlassian
 * apiToken, GitHub PAT, Anthropic apiKey, …) verbatim, which leaks
 * real, per-builder secrets onto the user's terminal and into any
 * captured CI log.
 *
 * The fix is a regex sweep on each output line: when a token
 * matches a known prefix shape, replace its middle with `…` and
 * keep the prefix + last 6 characters so the value is still
 * recognizable for debugging ("did the right token get loaded?")
 * without exposing the secret.
 *
 * What's **not** masked here, by design:
 *
 *   - The literal `monoceros` user/password baked into the compose
 *     service catalog (postgres, mysql). It's a documented dev-
 *     convention, identical on every Monoceros container, openly
 *     listed in `create/catalog.ts` and the components README. Not
 *     a secret. Masking it would just make the connection string
 *     harder to spot for the builder.
 *   - Anything that looks "password-shaped" via a key= pattern.
 *     Risk of false positives outweighs cosmetic benefit when the
 *     value isn't actually sensitive (see also ADR-style note in
 *     `create/catalog.ts`).
 */

interface SecretPattern {
  /** Short label for the pattern, useful in debugging. */
  name: string;
  /** Match shape. Must be a /g regex so all occurrences get replaced. */
  re: RegExp;
}

// Order doesn't matter — patterns are disjoint by prefix.
const PATTERNS: SecretPattern[] = [
  // Atlassian Cloud API token. Starts with literal `ATATT3xFf` plus
  // a long URL-safe-base64 tail. Tightened to that prefix to avoid
  // matching unrelated all-caps words.
  { name: 'atlassian-api', re: /ATATT3xFf[A-Za-z0-9+/=_-]{20,}/g },
  // Bitbucket Cloud app password.
  { name: 'bitbucket-app', re: /ATBB[A-Za-z0-9+/=_-]{20,}/g },
  // GitHub PAT (classic), OAuth, user, server, refresh — all share
  // the `gh<lower-letter>_<base62>` shape per GitHub's token format.
  { name: 'github-token', re: /gh[a-z]_[A-Za-z0-9]{20,}/g },
  // GitHub fine-grained PAT.
  { name: 'github-pat', re: /github_pat_[A-Za-z0-9_]{20,}/g },
  // Anthropic API key.
  { name: 'anthropic-api', re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
];

/**
 * Replace token-shaped substrings with a masked form. Idempotent
 * for already-masked strings (the elision character isn't part of
 * any pattern's alphabet).
 */
export function maskSecrets(text: string): string {
  let result = text;
  for (const { re } of PATTERNS) {
    result = result.replace(re, maskOne);
  }
  return result;
}

function maskOne(token: string): string {
  if (token.length <= 12) return token;
  return `${token.slice(0, 5)}…${token.slice(-6)}`;
}

/**
 * Transform stream that runs every chunk through `maskSecrets`.
 *
 * Tokens can in theory straddle a chunk boundary if the upstream
 * writer flushes mid-token, leaving an unmasked tail. Mitigation:
 * the transform holds back the last line of every chunk until a
 * newline arrives, since real Docker / devcontainer-cli output is
 * line-oriented and tokens don't contain newlines. On final flush
 * any leftover buffer is masked and emitted.
 */
export function createSecretMaskStream(): Transform {
  let buffer = '';
  return new Transform({
    decodeStrings: true,
    transform(chunk: Buffer | string, _enc, cb: TransformCallback): void {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      buffer += text;
      const lastNewline = buffer.lastIndexOf('\n');
      if (lastNewline === -1) {
        // No complete line yet — keep buffering. We'd rather hold
        // back partial output briefly than emit half a token.
        cb(null);
        return;
      }
      const flushable = buffer.slice(0, lastNewline + 1);
      buffer = buffer.slice(lastNewline + 1);
      cb(null, maskSecrets(flushable));
    },
    flush(cb: TransformCallback): void {
      if (buffer.length > 0) {
        const tail = maskSecrets(buffer);
        buffer = '';
        cb(null, tail);
        return;
      }
      cb(null);
    },
  });
}
