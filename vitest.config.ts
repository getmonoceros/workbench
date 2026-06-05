import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    // Only the workbench's own packages — never the dev `.local/`
    // MONOCEROS_HOME, where materialized containers and `remove`-backups
    // carry foreign test files (a builder's cloned repos) that vitest
    // would otherwise try to collect and fail on.
    include: ['packages/**/*.{test,spec}.?(c|m)[jt]s?(x)'],
  },
});
