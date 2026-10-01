import { EDITOR_ROOT_ELEMENT_ID } from '../../../common/index';
import { InputStopController } from '../../../webview/ui/input-stop';
import { OVERLAY_ELEMENT_ID, OverlayPresenter } from '../../../webview/ui/overlay-presenter';

/** The overlay presenter, together with what it presents into. */
export interface OverlayHarness {
  /** The editor root. */
  readonly root: HTMLElement;
  /** The input stop controller. */
  readonly inputStop: InputStopController;
  /** The overlay presenter. */
  readonly overlay: OverlayPresenter;
  /** The overlay element currently shown, or `null` when none is up. */
  readonly readOverlay: () => HTMLElement | null;
}

/**
 * Attaches the input stop controller and the overlay presenter to a document with an editor root.
 *
 * It only assembles the tools; the assertions are written on the test side.
 */
export function createOverlayHarness(): OverlayHarness {
  document.body.replaceChildren();
  const root = document.createElement('div');
  root.id = EDITOR_ROOT_ELEMENT_ID;
  root.contentEditable = 'true';
  document.body.append(root);

  const inputStop = new InputStopController({
    readEditorRoot: () => root,
    hasViewFocus: () => true,
    deferReturn: () => undefined,
    notifyResumed: () => undefined,
  });
  return {
    root,
    inputStop,
    overlay: new OverlayPresenter(window, inputStop, { notifyRendered: () => undefined }),
    readOverlay: () => document.getElementById(OVERLAY_ELEMENT_ID),
  };
}
