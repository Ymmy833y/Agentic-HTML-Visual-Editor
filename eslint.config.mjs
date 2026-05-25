import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['dist/', 'out-test/', 'coverage/', 'node_modules/', '.vscode-test/'],
  },

  // All TS files — type-aware rules
  {
    files: ['src/**/*.ts', 'webview/**/*.ts', 'tests/**/*.ts', '*.config.ts'],
    extends: tseslint.configs.recommendedTypeChecked,
    languageOptions: {
      parserOptions: {
        project: './tsconfig.eslint.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': 'warn',
    },
  },

  // src/ — Node.js globals
  {
    files: ['src/**/*.ts'],
    languageOptions: { globals: globals.node },
  },

  // webview/ — browser globals
  {
    files: ['webview/**/*.ts'],
    languageOptions: { globals: globals.browser },
  },

  // tests/ — relaxed rules
  {
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      'no-console': 'off',
    },
  },

  // CJS config files (esbuild.config.js etc.)
  {
    files: ['*.js'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: globals.node,
      sourceType: 'commonjs',
    },
  },
);
