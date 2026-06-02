import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    // `.local/` is the dev MONOCEROS_HOME — it holds materialized
    // containers and cloned solution repos (foreign source with its own
    // tooling), none of which is workbench code. Without this, a
    // `monoceros apply` that clones a repo under `.local/container/…`
    // pollutes `pnpm lint` with the cloned project's lint errors.
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '.local/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
