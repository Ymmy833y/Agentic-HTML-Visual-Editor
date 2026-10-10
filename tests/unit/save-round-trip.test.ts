import { describe, expect, it, vi } from 'vitest';

import { SaveRoundTrip } from '../../webview/save/save-round-trip';
import { INPUT_STOP_REASON } from '../../webview/ui/input-stop';
import { BLANK_OVERLAY_CONTENT } from '../../webview/ui/overlay-presenter';
import { createOverlayHarness } from './helpers/overlay-harness';

describe('a round trip while protected', () => {
  it('does not lift the stop of the protection on a release or a commit', () => {
    const harness = createOverlayHarness();
    const roundTrip = new SaveRoundTrip({
      overlay: harness.overlay,
      channel: { post: vi.fn() },
      createOutput: () => undefined,
      discardPendingOutput: vi.fn(),
      resendUnsavedContent: vi.fn(),
    });
    // Whoever receives the protection notice raises the overlay under the protection's reason.
    harness.overlay.present(INPUT_STOP_REASON.historyProtected, BLANK_OVERLAY_CONTENT);

    roundTrip.handleProtectionActivated();
    roundTrip.handleReleased(false);
    roundTrip.handleCommitted();

    expect([harness.root.contentEditable, harness.readOverlay() !== null]).toEqual(['false', true]);
  });
});
