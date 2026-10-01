import {
  BLOCK_SEPARATOR_TEXT,
  createEmptyBlock,
  hasFollowingContent,
  insertBlock,
  isEmptyBlock,
} from './block';
import { placeCaretAtStart } from './caret';

/**
 * Inserts a collapsible section next to the reference.
 *
 * Inserts immediately after the reference if it is not empty, or immediately before it if it is
 * empty. Leaving an empty reference in place gives it a line after the collapsible section, keeping
 * a way to place the caret there. The inserted collapsible section starts open, and its title carries
 * no text: fixed text would leave UI-locale-dependent wording in the saved HTML.
 *
 * Exceptions are not caught here; they are left to the caller's edit attempt.
 *
 * @param reference The element the operation acts on.
 * @returns `true` when the insert happened.
 */
export function insertDetailsSection(reference: Element): boolean {
  const document = reference.ownerDocument;
  const section = document.createElement('details');
  section.setAttribute('open', '');

  const title = createEmptyBlock(document, 'summary');
  // Place one line break before and after each of the collapsible section, title, and paragraph so
  // each lands on its own line. Packing them onto one line would let save-time normalization touch
  // the spelling of untouched blocks too.
  section.append(
    document.createTextNode(BLOCK_SEPARATOR_TEXT),
    title,
    document.createTextNode(BLOCK_SEPARATOR_TEXT),
    createEmptyBlock(document, 'p'),
    document.createTextNode(BLOCK_SEPARATOR_TEXT),
  );

  insertBlock(section, reference, isEmptyBlock(reference) ? 'before' : 'after');

  // Skip adding a paragraph if content follows; adding one unconditionally would leave a blank line
  // in the middle of the document.
  if (!hasFollowingContent(section)) {
    insertBlock(createEmptyBlock(document, 'p'), section, 'after');
  }

  // Even with a range selection active, the selected characters are neither moved into the title nor
  // deleted. Placing the caret resolves the range selection.
  placeCaretAtStart(title);
  return true;
}
