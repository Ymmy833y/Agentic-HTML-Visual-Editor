import type { Localizer } from '../../common/index';
import type { OverlayContent } from './overlay-presenter';

/** Why the document was deemed unopenable. */
export type UnopenableReason =
  /** The body boundaries could not be determined uniquely. */
  | { readonly kind: 'boundary' }
  /** The body contained a tag that makes the document unopenable. */
  | { readonly kind: 'forbiddenTag'; readonly tagName: string };

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
  // The tag name tells users what to do next. Without it, they would have to search in the standard
  // text editor without knowing which part of the document caused the problem.
  const description = reason.kind === 'forbiddenTag'
    ? localizer.getMessage('unopenableDocument.forbiddenTag', { tagName: reason.tagName })
    : localizer.getMessage('unopenableDocument.condition');

  return {
    heading: localizer.getMessage('unopenableDocument.heading'),
    descriptions: [description],
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
