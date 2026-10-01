// A representative test that only confirms the webview bundle starts in a real browser and can make a
// round trip with the stub host.
// bootstrap.spec.ts verifies the first message sent by the bundle itself. This file retains tests of
// the stub host itself, and cases that access its API directly run on a page without the bundle. The
// bundle acquires the API when loaded, and the API can be acquired only once.
import { expect, test } from '@playwright/test';
import { getOutboundMessages, openStubHost, openWebviewHost, sendToWebview } from './helpers/page';

declare global {
  interface Window {
    // Receptacle for the injected messages. It lives on the page so the listener is registered before the injection.
    __receivedMessages?: unknown[];
  }
}

test.describe('e2e layer startup path', () => {
  test('loads the webview bundle with no page errors', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await openWebviewHost(page);

    expect(pageErrors).toEqual([]);
  });

  test('records the messages sent to the host in the stub host, in the order they were sent', async ({ page }) => {
    await openStubHost(page);

    await page.evaluate(() => {
      const acquire = window.acquireVsCodeApi;
      if (!acquire) {
        throw new Error('acquireVsCodeApi is not installed');
      }
      const api = acquire();
      api.postMessage({ order: 1 });
      api.postMessage({ order: 2 });
    });

    expect(await getOutboundMessages(page)).toEqual([{ order: 1 }, { order: 2 }]);
  });

  test('delivers a message injected from the stub host to the message listener on the page', async ({ page }) => {
    await openWebviewHost(page);

    // Registration and retrieval are split into separate evaluations to guarantee that the listener is
    // registered before the injection.
    await page.evaluate(() => {
      const received: unknown[] = [];
      window.__receivedMessages = received;
      window.addEventListener('message', (event) => {
        received.push(event.data);
      });
    });

    await sendToWebview(page, { kind: 'inbound' });

    const received = await page.evaluate(() => window.__receivedMessages ?? []);
    expect(received).toEqual([{ kind: 'inbound' }]);
  });

  test('throws from the startup helper when the bundle path does not exist', async ({ page }) => {
    await expect(openWebviewHost(page, 'dist/no-such-bundle.js')).rejects.toThrow();
  });

  test('throws on the second call to acquireVsCodeApi', async ({ page }) => {
    await openStubHost(page);

    const secondCallThrew = await page.evaluate(() => {
      const acquire = window.acquireVsCodeApi;
      if (!acquire) {
        throw new Error('acquireVsCodeApi is not installed');
      }
      acquire();
      try {
        acquire();
        return false;
      } catch {
        return true;
      }
    });

    expect(secondCallThrew).toBe(true);
  });

  test('throws when a value that cannot be cloned is posted, and leaves nothing in the record', async ({ page }) => {
    await openStubHost(page);

    const postThrew = await page.evaluate(() => {
      const acquire = window.acquireVsCodeApi;
      if (!acquire) {
        throw new Error('acquireVsCodeApi is not installed');
      }
      const api = acquire();
      try {
        api.postMessage({ callback: () => undefined });
        return false;
      } catch {
        return true;
      }
    });

    expect(postThrew).toBe(true);
    expect(await getOutboundMessages(page)).toEqual([]);
  });

  test('keeps the record as it was at send time even when the original object is rewritten afterwards', async ({ page }) => {
    await openStubHost(page);

    await page.evaluate(() => {
      const acquire = window.acquireVsCodeApi;
      if (!acquire) {
        throw new Error('acquireVsCodeApi is not installed');
      }
      const message = { version: 1 };
      acquire().postMessage(message);
      message.version = 2;
    });

    expect(await getOutboundMessages(page)).toEqual([{ version: 1 }]);
  });
});
