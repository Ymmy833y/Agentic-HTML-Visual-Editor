import { describe, expect, it } from 'vitest';

import { VIEW_TO_HOST_MESSAGE_TYPE, createLocalizer } from '../../common/index';
import type { ViewToHostMessage } from '../../common/index';
import type { DocumentBoundary } from '../../webview/document/document-boundary';
import type { BodyOutput } from '../../webview/document/serialization-state';
import { UnsavedContentSender } from '../../webview/messaging/unsaved-content-sender';
import { DeliveryFailureController } from '../../webview/messaging/delivery-failure-controller';
import { createOverlayHarness } from './helpers/overlay-harness';

const BOUNDARY: DocumentBoundary = {
  prologue: '<!DOCTYPE html>\n<html>\n<body>',
  body: '\n<p>ab</p>\n',
  epilogue: '</body>\n</html>\n',
};

/** Creates a body output. This test checks only joining, so the current form may match the body. */
function output(body: string): BodyOutput {
  return { body, current: body };
}

interface Harness {
  readonly sender: UnsavedContentSender;
  /** Messages sent to the host, in send order. */
  readonly posted: ViewToHostMessage[];
  /** Sets whether sending fails. */
  setFailing: (failing: boolean) => void;
  readonly root: HTMLElement;
  readonly readOverlay: () => HTMLElement | null;
  readonly clickRetry: () => void;
}

/**
 * Creates an unsaved content sender together with its destination and editor root.
 *
 * @param boundary The value returned by the boundary reader, or `undefined` if undetermined.
 */
function createHarness(boundary: DocumentBoundary | undefined): Harness {
  const overlayHarness = createOverlayHarness();
  const root = overlayHarness.root;

  const posted: ViewToHostMessage[] = [];
  let failing = false;

  const failureController = new DeliveryFailureController(
    overlayHarness.overlay,
    createLocalizer({}),
    () => undefined,
  );

  const sender = new UnsavedContentSender(
    {
      post: (message) => {
        // A send failure in the real environment is reported as a synchronous exception.
        if (failing) {
          throw new Error('Failed to send');
        }
        posted.push(message);
      },
    },
    () => boundary,
    failureController,
  );
  failureController.registerRoute(
    'unsavedContent',
    () => sender.hasUnsentContent(),
    () => sender.retry(),
  );

  return {
    sender,
    posted,
    setFailing: (value) => {
      failing = value;
    },
    root,
    readOverlay: overlayHarness.readOverlay,
    clickRetry: () => {
      const button = overlayHarness.readOverlay()?.querySelector('button');
      if (button === null || button === undefined) {
        throw new Error('The overlay is not visible');
      }
      button.click();
    },
  };
}

describe('sending view edited messages', () => {
  it('sends one content-free view edited message for one immediate notification', () => {
    const harness = createHarness(BOUNDARY);

    harness.sender.onEditDetected('insertText');

    expect(harness.posted).toEqual([{ type: VIEW_TO_HOST_MESSAGE_TYPE.viewEdited }]);
  });

  it('shows the overlay and makes the editor root non-editable when sending throws', () => {
    const harness = createHarness(BOUNDARY);
    harness.setFailing(true);

    harness.sender.onEditDetected('insertText');

    expect([harness.readOverlay() !== null, harness.root.contentEditable]).toEqual([true, 'false']);
  });
});

describe('sending unsaved content messages', () => {
  it('sends the complete document text after joining a body output with its boundary', () => {
    const harness = createHarness(BOUNDARY);

    harness.sender.onBodyOutput(output('\n<p>abX</p>\n'));

    expect(harness.posted).toEqual([
      {
        type: VIEW_TO_HOST_MESSAGE_TYPE.unsavedContent,
        text: '<!DOCTYPE html>\n<html>\n<body>\n<p>abX</p>\n</body>\n</html>\n',
      },
    ]);
  });

  it('sends nothing for a body output while the document boundary is undetermined', () => {
    const harness = createHarness(undefined);

    harness.sender.onBodyOutput(output('\n<p>abX</p>\n'));

    expect(harness.posted).toEqual([]);
  });

  it('sends a second unsaved content message even when the body output is unchanged', () => {
    const harness = createHarness(BOUNDARY);
    harness.sender.onBodyOutput(output('\n<p>abX</p>\n'));

    harness.sender.onBodyOutput(output('\n<p>abX</p>\n'));

    expect(harness.posted).toHaveLength(2);
  });

  it('replaces unsent content with the latest body output after consecutive failures', () => {
    const harness = createHarness(BOUNDARY);
    harness.setFailing(true);
    harness.sender.onBodyOutput(output('\n<p>abX</p>\n'));
    harness.sender.onBodyOutput(output('\n<p>abXY</p>\n'));

    harness.setFailing(false);
    harness.sender.retry();

    expect(harness.posted).toEqual([
      {
        type: VIEW_TO_HOST_MESSAGE_TYPE.unsavedContent,
        text: '<!DOCTYPE html>\n<html>\n<body>\n<p>abXY</p>\n</body>\n</html>\n',
      },
    ]);
  });
});

describe('resending unsent content', () => {
  it('delivers unsent items, removes the overlay, and resumes editing when all retries succeed', () => {
    const harness = createHarness(BOUNDARY);
    harness.setFailing(true);
    harness.sender.onEditDetected('insertText');
    harness.sender.onBodyOutput(output('\n<p>abX</p>\n'));

    harness.setFailing(false);
    harness.clickRetry();

    expect([
      harness.posted.map((message) => message.type),
      harness.readOverlay(),
      harness.root.contentEditable,
    ]).toEqual([
      [VIEW_TO_HOST_MESSAGE_TYPE.viewEdited, VIEW_TO_HOST_MESSAGE_TYPE.unsavedContent],
      null,
      'true',
    ]);
  });

  it('keeps the overlay and editor root non-editable when retrying also fails', () => {
    const harness = createHarness(BOUNDARY);
    harness.setFailing(true);
    harness.sender.onEditDetected('insertText');

    harness.clickRetry();

    expect([harness.readOverlay() !== null, harness.root.contentEditable]).toEqual([true, 'false']);
  });
});

describe('presence of unsent content', () => {
  it('reports unsent content while a failed edit notice remains', () => {
    const harness = createHarness(BOUNDARY);
    harness.setFailing(true);

    harness.sender.onEditDetected('insert');

    expect(harness.sender.hasUnsentContent()).toBe(true);
  });

  it('reports no unsent content after a successful resend', () => {
    const harness = createHarness(BOUNDARY);
    harness.setFailing(true);
    harness.sender.onEditDetected('insert');
    harness.setFailing(false);

    harness.sender.retry();

    expect(harness.sender.hasUnsentContent()).toBe(false);
  });
});

describe('resending on a save released message', () => {
  it('sends exactly one marked unsaved content message on a resend', () => {
    const harness = createHarness(BOUNDARY);

    harness.sender.resend(output('\n<p>abX</p>\n'));

    expect(harness.posted).toEqual([
      {
        type: VIEW_TO_HOST_MESSAGE_TYPE.unsavedContent,
        text: '<!DOCTYPE html>\n<html>\n<body>\n<p>abX</p>\n</body>\n</html>\n',
        resent: true,
      },
    ]);
  });

  it('sends nothing when the document boundary is undetermined', () => {
    const harness = createHarness(undefined);

    harness.sender.resend(output('\n<p>abX</p>\n'));

    expect(harness.posted).toEqual([]);
  });

  it('shows the send failure overlay when the send fails', () => {
    const harness = createHarness(BOUNDARY);
    harness.setFailing(true);

    harness.sender.resend(output('\n<p>abX</p>\n'));

    expect([harness.posted, harness.readOverlay() !== null]).toEqual([[], true]);
  });

  it('keeps the resend marker on a retry after a failed send', () => {
    const harness = createHarness(BOUNDARY);
    harness.setFailing(true);
    harness.sender.resend(output('\n<p>abX</p>\n'));
    harness.setFailing(false);

    harness.sender.retry();

    expect(harness.posted).toEqual([
      {
        type: VIEW_TO_HOST_MESSAGE_TYPE.unsavedContent,
        text: '<!DOCTYPE html>\n<html>\n<body>\n<p>abX</p>\n</body>\n</html>\n',
        resent: true,
      },
    ]);
  });
});
