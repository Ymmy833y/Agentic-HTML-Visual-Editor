import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createLocalizer } from '../../common/index';
import { INPUT_STOP_REASON } from '../../webview/ui/input-stop';
import { BLANK_OVERLAY_CONTENT, OVERLAY_ELEMENT_ID } from '../../webview/ui/overlay-presenter';
import { buildRestoreFailureOverlay } from '../../webview/ui/restore-failure-dialog';
import { buildSendFailureOverlay } from '../../webview/ui/send-failure-overlay';
import { buildUnopenableDocumentOverlay } from '../../webview/ui/unopenable-document-dialog';
import { createOverlayHarness } from './helpers/overlay-harness';

const localizer = createLocalizer({
  'unopenableDocument.heading': 'Cannot open',
  'unopenableDocument.condition': 'These are the conditions',
  'unopenableDocument.forbiddenTag': 'The body contains <{tagName}>',
  'unopenableDocument.openInTextEditor': 'Switch to text',
  'restoreFailure.heading': 'Could not restore',
  'restoreFailure.backupUnreadable': 'Cannot read the backup',
  'restore.retry': 'Retry',
  'restore.discard': 'Discard',
  'sendFailure.heading': 'Could not send',
  'sendFailure.description': 'Not delivered',
  'sendFailure.retry': 'Retry sending',
  'editCaptureFailure.description': 'Reload required',
});

const ignore = (): void => undefined;

// The reasons presented as an overlay. The action dialog is excluded because it shows itself in its
// own element. Spelling the expected order out by hand would not catch an implementation that keeps
// a second, copied order of its own.
const OVERLAY_REASONS = Object.values(INPUT_STOP_REASON)
  .filter((reason) => reason !== INPUT_STOP_REASON.actionDialog);

/** Reads the labels of the overlay actions laid out on the overlay, in order. */
function readActionLabels(overlay: HTMLElement | null): (string | null)[] {
  return Array.from(overlay?.querySelectorAll('button') ?? [], (button) => button.textContent);
}

describe('presenting the overlay', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('keeps a single element when two reasons ask for a blank overlay, and keeps it after one is lowered', () => {
    const harness = createOverlayHarness();

    harness.overlay.present(INPUT_STOP_REASON.saveRoundTrip, BLANK_OVERLAY_CONTENT);
    harness.overlay.present(INPUT_STOP_REASON.historyProtected, BLANK_OVERLAY_CONTENT);
    harness.overlay.dismiss(INPUT_STOP_REASON.saveRoundTrip);

    expect(document.querySelectorAll(`#${OVERLAY_ELEMENT_ID}`)).toHaveLength(1);
  });

  it('lays out both the switch action and the restore failure actions when a restore failure is stacked on an unopenable document', () => {
    const harness = createOverlayHarness();

    harness.overlay.present(
      INPUT_STOP_REASON.unopenableDocument,
      buildUnopenableDocumentOverlay(localizer, { kind: 'boundary' }, ignore, ignore),
    );
    harness.overlay.present(
      INPUT_STOP_REASON.restoreIncomplete,
      buildRestoreFailureOverlay(localizer, 'backupUnreadable', ignore),
    );

    expect(readActionLabels(harness.readOverlay())).toEqual(['Switch to text', 'Retry', 'Discard']);
  });

  it('does not call the stale receiver on a press after the same reason is presented with new content', () => {
    const harness = createOverlayHarness();
    const stale = vi.fn();
    harness.overlay.present(INPUT_STOP_REASON.sendFailure, {
      heading: 'Could not send',
      descriptions: [],
      actions: [{ label: 'Retry sending', run: stale }],
    });

    harness.overlay.present(INPUT_STOP_REASON.sendFailure, {
      heading: 'Could not send',
      descriptions: [],
      actions: [{ label: 'Retry sending', run: ignore }],
    });
    harness.readOverlay()?.querySelector('button')?.click();

    expect(stale).not.toHaveBeenCalled();
  });

  it('does nothing when a reason that is not up is lowered, and keeps the overlay of another reason', () => {
    const harness = createOverlayHarness();
    harness.overlay.present(
      INPUT_STOP_REASON.unopenableDocument,
      buildUnopenableDocumentOverlay(localizer, { kind: 'boundary' }, ignore, ignore),
    );

    harness.overlay.dismiss(INPUT_STOP_REASON.restoreIncomplete);

    expect(readActionLabels(harness.readOverlay())).toEqual(['Switch to text']);
  });

  it('reports whether it lowered, returning false for a reason that is not up even while another remains', () => {
    const harness = createOverlayHarness();
    harness.overlay.present(INPUT_STOP_REASON.historyProtected, BLANK_OVERLAY_CONTENT);

    expect([
      harness.overlay.dismiss(INPUT_STOP_REASON.restoreIncomplete),
      harness.overlay.dismiss(INPUT_STOP_REASON.historyProtected),
    ]).toEqual([false, true]);
  });

  it('draws every reason but the action dialog as a section, in the order of the reasons', () => {
    const harness = createOverlayHarness();
    const reasons = OVERLAY_REASONS;

    for (const reason of reasons) {
      harness.overlay.present(reason, { heading: reason, descriptions: [], actions: [] });
    }

    expect(Array.from(
      harness.readOverlay()?.children ?? [],
      (section) => section.textContent,
    )).toEqual(reasons);
  });

  it('carries no role while there is nothing but a blank overlay', () => {
    const harness = createOverlayHarness();

    harness.overlay.present(INPUT_STOP_REASON.saveRoundTrip, BLANK_OVERLAY_CONTENT);

    expect(harness.readOverlay()?.hasAttribute('role')).toBe(false);
  });

  it('gains a role when a reason with content is stacked on a blank overlay', () => {
    const harness = createOverlayHarness();
    harness.overlay.present(INPUT_STOP_REASON.saveRoundTrip, BLANK_OVERLAY_CONTENT);

    harness.overlay.present(
      INPUT_STOP_REASON.restoreIncomplete,
      buildRestoreFailureOverlay(localizer, 'backupUnreadable', ignore),
    );

    expect(harness.readOverlay()?.getAttribute('role')).toBe('alertdialog');
  });

  it('drops the role again when only the reason with content is lowered', () => {
    const harness = createOverlayHarness();
    harness.overlay.present(INPUT_STOP_REASON.saveRoundTrip, BLANK_OVERLAY_CONTENT);
    harness.overlay.present(
      INPUT_STOP_REASON.restoreIncomplete,
      buildRestoreFailureOverlay(localizer, 'backupUnreadable', ignore),
    );

    harness.overlay.dismiss(INPUT_STOP_REASON.restoreIncomplete);

    expect(harness.readOverlay()?.hasAttribute('role')).toBe(false);
  });

  it('puts a message in as text rather than as an element', () => {
    const harness = createOverlayHarness();

    harness.overlay.present(
      INPUT_STOP_REASON.unopenableDocument,
      buildUnopenableDocumentOverlay(localizer, { kind: 'forbiddenTag', tagName: 'script' }, ignore, ignore),
    );

    expect(harness.readOverlay()?.querySelector('script')).toBeNull();
  });
});

describe('the content of the send failure overlay', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('offers no retry action when there is only a capture failure', () => {
    const content = buildSendFailureOverlay(
      localizer,
      { deliveryFailed: false, captureFailed: true },
      ignore,
    );

    expect([content.actions, content.descriptions]).toEqual([[], ['Reload required']]);
  });

  it('offers a retry action only when there is a delivery failure', () => {
    const content = buildSendFailureOverlay(
      localizer,
      { deliveryFailed: true, captureFailed: true },
      ignore,
    );

    expect([
      content.actions.map((action) => action.label),
      content.descriptions,
    ]).toEqual([['Retry sending'], ['Not delivered', 'Reload required']]);
  });
});
