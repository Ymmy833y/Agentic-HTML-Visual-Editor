import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['tests/unit/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['webview/**/*.ts'],
      exclude: ['webview/main.ts', 'webview/styles/**'],
    },
  },
});
