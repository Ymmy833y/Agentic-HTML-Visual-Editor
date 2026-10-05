import type { Localizer } from '../../common/index';
import type { OverlayContent } from './overlay-presenter';

/** Why the document was deemed unopenable. */
export type UnopenableReason =
  /** The body boundaries could not be determined uniquely. */
  | { readonly kind: 'boundary' }
  /** The body contained a tag that makes the document unopenable. */
  | { readonly kind: 'forbiddenTag'; readonly tagName: string }
  /** The host found that the text was decoded with an encoding that does not match the file's bytes. */
  | { readonly kind: 'encodingMismatch' };

/**
 * Builds the overlay content explaining that the document cannot be edited and the conditions under
 * which it can be opened.
 *
 * Showing only an empty view without an explanation would look broken to the user.
 *
 * Places one button that switches to the standard text editor. The file cannot be edited in this view, so it
 * gives the user a direct way to fix it.
 *
 * @param localizer The localizer.
 * @param reason Why the document was deemed unopenable. The heading is shared; only the second
 * sentence varies by this reason.
 * @param requestTextEditorSwitch The receiver called each time the text editor switch button is pressed.
 * @returns The overlay content.
 */
export function buildUnopenableDocumentOverlay(
  localizer: Localizer,
  reason: UnopenableReason,
  requestTextEditorSwitch: () => void,
): OverlayContent {
  return {
    heading: localizer.getMessage('unopenableDocument.heading'),
    descriptions: [describeReason(localizer, reason)],
    actions: [
      {
        label: localizer.getMessage('unopenableDocument.openInTextEditor'),
        // Repeated clicks are not throttled here. The host discards later requests that arrive while a switch of the
        // same file is in progress.
        run: requestTextEditorSwitch,
      },
    ],
  };
}

/**
 * Picks the sentence that tells the user why the document cannot be opened and what to do about it.
 *
 * @param localizer The localizer.
 * @param reason Why the document was deemed unopenable.
 * @returns The second sentence of the overlay.
 */
function describeReason(localizer: Localizer, reason: UnopenableReason): string {
  switch (reason.kind) {
    case 'forbiddenTag':
      // The tag name tells users what to do next. Without it, they would have to search in the standard
      // text editor without knowing which part of the document caused the problem.
      return localizer.getMessage('unopenableDocument.forbiddenTag', { tagName: reason.tagName });
    case 'encodingMismatch':
      return localizer.getMessage('unopenableDocument.encodingMismatch');
    case 'boundary':
      return localizer.getMessage('unopenableDocument.condition');
  }
}
