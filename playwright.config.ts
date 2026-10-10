import { defineConfig, devices } from '@playwright/test';

// End-to-end layer configuration.
export default defineConfig({
  testDir: './tests/e2e',
  // Split from the unit layer's *.test.ts by extension.
  testMatch: '**/*.spec.ts',
  // Each test opens its own page and holds no shared state.
  fullyParallel: true,
  retries: 0,
  projects: [
    // A webview is really a Chromium embedded in VS Code, so verifying other engines would not match
    // the real environment.
    // The views fade and ease their colors, and specs read computed colors right after a state change. Reduced motion
    // switches those transitions off, so a read never lands halfway through one. It has to be set through
    // contextOptions: the reducedMotion option of `use` is not applied.
    { name: 'chromium', use: { ...devices['Desktop Chrome'], contextOptions: { reducedMotion: 'reduce' } } },
  ],
});
