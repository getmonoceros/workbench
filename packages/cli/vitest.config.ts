import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    env: {
      // An empty home of its own. Without it the default resolves to the
      // checkout's `.local`, and whatever the developer keeps there (their
      // own templates and services) leaks into every test that loads the
      // catalog. Tests that need a home still set their own.
      MONOCEROS_HOME: mkdtempSync(path.join(tmpdir(), 'monoceros-vitest-')),
    },
  },
});
