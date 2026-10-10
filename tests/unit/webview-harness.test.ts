// A representative test that only confirms the unit layer can load webview straight from source on jsdom.
// Verification that involves the caret, the selection, or key input belongs to the e2e layer.
import { beforeAll, describe, expect, it } from 'vitest';

// Transforming the modules behind the entry point for the first time takes several seconds even on its own.
// Running the 3 layers at once pushes it past the default 5 seconds and fails, so the import time limit is
// extended.
const ENTRY_IMPORT_TIMEOUT_MS = 30_000;

describe('unit layer startup path (webview)', () => {
  beforeAll(() => {
    // The entry point starts when imported and acquires the host channel. Without this stub, the
    // import would throw before the test could verify that the entry point loads.
    window.acquireVsCodeApi = () => ({ postMessage: () => undefined });
  });

  it('imports the webview entry point on jsdom', async () => {
    await expect(import('../../webview/main')).resolves.toBeDefined();
  }, ENTRY_IMPORT_TIMEOUT_MS);

  it('has document available in the jsdom environment', () => {
    expect(document.body).toBeInstanceOf(HTMLElement);
  });
});
