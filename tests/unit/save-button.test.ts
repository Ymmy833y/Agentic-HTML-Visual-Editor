import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EDITOR_ROOT_ELEMENT_ID,
  VIEW_TO_HOST_MESSAGE_TYPE,
  createLocalizer,
} from '../../common/index';
import type { ViewToHostMessage } from '../../common/index';
import { SaveButton } from '../../webview/ui/save-button';
import { attachToolbar } from '../../webview/ui/toolbar';
import { ToolbarActivation } from '../../webview/ui/toolbar-activation';
import { TOOLBAR_SLOT } from '../../webview/ui/toolbar-slots';
import { TooltipController } from '../../webview/ui/tooltip';

interface Harness {
  readonly saveButton: SaveButton;
  /** The messages sent to the host, in the order they were sent. */
  readonly posted: ViewToHostMessage[];
  /** The lines sent as diagnostics. */
  readonly diagnostics: string[];
  /** Whether the indicator is shown. */
  readonly hasIndicator: () => boolean;
}

/**
 * Prepares a toolbar with the save button registered.
 *
 * @param failSend Whether to make sending fail.
 */
function createHarness(failSend = false): Harness {
  document.body.replaceChildren();
  const root = document.createElement('div');
  root.id = EDITOR_ROOT_ELEMENT_ID;
  document.body.append(root);

  const posted: ViewToHostMessage[] = [];
  const diagnostics: string[] = [];
  const toolbar = attachToolbar(
    window,
    createLocalizer({ 'toolbar.save': 'Save' }),
    new ToolbarActivation(window, {
      isInputStopped: () => false,
      isComposing: () => false,
      notifyPopupOpened: () => undefined,
      notifyPopupClosed: () => undefined,
      notifyBeforeRun: () => undefined,
    }),
    new TooltipController(window),
  );
  if (toolbar === undefined) {
    throw new Error('The toolbar could not be attached');
  }

  const saveButton = new SaveButton(
    toolbar,
    {
      post: (message) => {
        if (failSend) {
          throw new Error('Failed to send to the host');
        }
        posted.push(message);
      },
    },
    (detail) => diagnostics.push(detail),
  );

  return {
    saveButton,
    posted,
    diagnostics,
    hasIndicator: () =>
      document.querySelector(`[data-slot="${TOOLBAR_SLOT.save}"] .toolbar-indicator`) !== null,
  };
}

describe('sending the save request', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('sends exactly one save request when pressed', () => {
    const harness = createHarness();

    harness.saveButton.requestSave();

    expect(harness.posted).toEqual([{ type: VIEW_TO_HOST_MESSAGE_TYPE.saveRequested }]);
  });

  it('lets no exception out when sending fails, and sends one diagnostic line', () => {
    const harness = createHarness(true);

    expect(() => harness.saveButton.requestSave()).not.toThrow();
    expect(harness.diagnostics).toHaveLength(1);
  });

  it('leaves the indicator unchanged when sending fails', () => {
    const harness = createHarness(true);
    harness.saveButton.applyDirtyState(true);

    harness.saveButton.requestSave();

    expect(harness.hasIndicator()).toBe(true);
  });
});

describe('the dirty indicator', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('shows the indicator on receiving a dirty state', () => {
    const harness = createHarness();

    harness.saveButton.applyDirtyState(true);

    expect(harness.hasIndicator()).toBe(true);
  });

  it('hides the indicator on receiving a clean state', () => {
    const harness = createHarness();
    harness.saveButton.applyDirtyState(true);

    harness.saveButton.applyDirtyState(false);

    expect(harness.hasIndicator()).toBe(false);
  });

  it('leaves the display unchanged when the same value arrives twice in a row', () => {
    const harness = createHarness();
    harness.saveButton.applyDirtyState(true);

    harness.saveButton.applyDirtyState(true);

    expect(
      document.querySelectorAll(`[data-slot="${TOOLBAR_SLOT.save}"] .toolbar-indicator`),
    ).toHaveLength(1);
  });

  it('does not move the indicator on a press in the view', () => {
    const harness = createHarness();

    harness.saveButton.requestSave();

    expect(harness.hasIndicator()).toBe(false);
  });
});
