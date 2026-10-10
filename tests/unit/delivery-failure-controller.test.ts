import { describe, expect, it, vi } from 'vitest';

import { createLocalizer } from '../../common/index';
import { DeliveryFailureController } from '../../webview/messaging/delivery-failure-controller';
import { createOverlayHarness } from './helpers/overlay-harness';

const localizer = createLocalizer({
  'sendFailure.heading': 'Delivery failed',
  'sendFailure.description': 'Items remain unsent',
  'sendFailure.retry': 'Retry',
  'editCaptureFailure.description': 'Reload is required',
});

describe('shared delivery failure control', () => {
  it('retries both routes once and keeps input blocked when one route still has unsent items', () => {
    const harness = createOverlayHarness();
    const controller = new DeliveryFailureController(harness.overlay, localizer, () => undefined);
    let unsavedPending = true;
    let historyPending = true;
    const retryUnsaved = vi.fn(() => {
      unsavedPending = false;
    });
    const retryHistory = vi.fn();
    controller.registerRoute('unsaved', () => unsavedPending, retryUnsaved);
    controller.registerRoute('history', () => historyPending, retryHistory);
    controller.reportDeliveryFailure();

    controller.retry();

    expect([retryUnsaved.mock.calls.length, retryHistory.mock.calls.length]).toEqual([1, 1]);
    expect([harness.readOverlay() !== null, harness.root.contentEditable]).toEqual([true, 'false']);
    historyPending = false;
  });

  it('keeps the overlay and input block while capture failure remains after delivery recovers', () => {
    const harness = createOverlayHarness();
    const diagnostics: string[] = [];
    const controller = new DeliveryFailureController(
      harness.overlay,
      localizer,
      (detail) => diagnostics.push(detail),
    );
    let pending = true;
    controller.registerRoute('history', () => pending, () => {
      pending = false;
    });
    controller.reportDeliveryFailure();
    controller.reportCaptureFailure('Could not capture the endpoint');

    controller.retry();

    expect([
      harness.readOverlay()?.textContent,
      harness.root.contentEditable,
      diagnostics,
    ]).toEqual([
      expect.stringContaining('Reload is required'),
      'false',
      ['Could not capture the endpoint'],
    ]);
  });

  it('lowers the send and capture failure overlay when the editing session is swapped', () => {
    const harness = createOverlayHarness();
    const controller = new DeliveryFailureController(harness.overlay, localizer, () => undefined);
    controller.reportDeliveryFailure();

    controller.dispose();

    expect([harness.readOverlay(), harness.root.contentEditable]).toEqual([null, 'true']);
  });
});
