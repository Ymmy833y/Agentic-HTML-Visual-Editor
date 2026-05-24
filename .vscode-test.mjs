import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'out-test/tests/integration/suite/**/*.test.js',
  workspaceFolder: './test-fixtures',
  mocha: {
    ui: 'tdd',
    timeout: 60000,
  },
});
