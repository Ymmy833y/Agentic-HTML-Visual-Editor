import { resolveImageSources } from '../document/image-source-resolver';
import { parseInertFragment } from '../document/inert-fragment';
import { findBlock, isEmptyBlock } from './block';
import type { BlockRewriteProgress } from './block-format';
import { placeCaret, readSelectionRange } from './caret';
import { isFormattingExcluded } from './inline-format';

/**
 * The edit kind of an image insertion.
 *
 * History groups only typing and deletes, so this is spelled differently from both to keep it from being
 * grouped with the input before and after it. One commit that combines the range delete and the image
 * insertion becomes one undo unit.
 */
export const IMAGE_INSERT_EDIT_KIND = 'image:insert';

/**
 * The input values of the image dialog. Each has surrounding whitespace removed, and an empty string means
 * nothing was entered in that field.
 */
export interface ImageValues {
  /** The image path or URL. */
  readonly source: string;
  /** The alt text. */
  readonly alt: string;
  /** The width (px). */
  readonly width: string;
  /** The height (px). */
  readonly height: string;
}

/**
 * The ports of the image insertion.
 *
 * The ports hold no values and are read on every call. The editing session changes with a document
 * replacement, and the input stop changes from moment to moment.
 * The base URIs hold the values of the mount target as they are. They do not change across replacements
 * and match the base the mount uses to resolve images.
 */
export interface ImageInsertPorts {
  /** Returns the editor root. `undefined` before the mount. */
  readEditorRoot(): Element | undefined;

  /** Whether an IME composition is in progress at the time of the call. */
  isComposing(): boolean;

  /** Whether any input stop reason remains. */
  isInputStopped(): boolean;

  /**
   * Runs a command that changes the tree as one edit attempt spanning the states before and after.
   *
   * @param kind The edit kind.
   * @param command A command that returns true only when it changed the tree.
   * @returns Whether the tree was changed. False if the attempt could not be started.
   */
  runCommandEdit(kind: string, command: () => boolean): boolean;

  /**
   * Ensures a target block and deletes the range, if any. The guards registered for range deletes apply
   * just as they do to an ordinary delete.
   *
   * @param range The selection range.
   * @returns The target block after the delete, or `undefined` if none could be ensured.
   */
  deleteRange(range: Range): Element | undefined;

  /** Leaves one diagnostic line for maintainers. Not used to notify the user. */
  reportDiagnostic(detail: string): void;

  /** The document URI that relative paths are resolved against. May be empty. */
  readonly documentUri: string;

  /** The resource root URI. May be empty. */
  readonly resourceRootUri: string;
}

/**
 * Builds one image to put into the document from image values that passed validation.
 *
 * It is built in an inert fragment detached from the live document. Building it in the live document would
 * start a fetch of the still unresolved relative path as soon as `src` is set. Relative paths are resolved
 * with the same rules and base URIs as the mount, so the image renders without waiting for a replacement,
 * while the saved `src` keeps the value that was entered.
 *
 * @param values Image values that passed validation.
 * @param document The live document. The inert fragment is created from this document.
 * @param documentUri The document URI that relative paths are resolved against. Nothing is resolved if empty.
 * @param resourceRootUri The resource root URI. Nothing is resolved if empty.
 * @returns The `img` placed in the inert fragment.
 */
export function buildImage(
  values: ImageValues,
  document: Document,
  documentUri: string,
  resourceRootUri: string,
): Element {
  const fragment = parseInertFragment('', document);
  const image = fragment.ownerDocument.createElement('img');
  image.setAttribute('src', values.source);
  // An empty alt declares the image decorative. An empty field cannot tell a decorative intent from a
  // forgotten value, so no alt is added.
  if (values.alt !== '') {
    image.setAttribute('alt', values.alt);
  }
  // The default styles set the height to auto to keep the aspect ratio, which overrides the height
  // attribute. A style declaration overrides the default styles.
  const declarations: string[] = [];
  if (values.width !== '') {
    declarations.push(`width: ${values.width}px;`);
  }
  if (values.height !== '') {
    declarations.push(`height: ${values.height}px;`);
  }
  if (declarations.length > 0) {
    image.setAttribute('style', declarations.join(' '));
  }
  fragment.append(image);
  resolveImageSources(fragment, documentUri, resourceRootUri);
  return image;
}

/**
 * Inserts an image at the selection as one standalone edit and places the caret right after the image.
 *
 * A range is deleted first and then replaced. Deleting the range by hand would skip the guards registered
 * for range deletes to protect structures and comments, so it goes through the editing session's range
 * delete. The block is not split; the image goes inline at the caret.
 *
 * @param ports The ports of the image insertion.
 * @param values Image values that passed validation.
 * @returns Whether the tree was changed.
 */
export function insertImage(ports: ImageInsertPorts, values: ImageValues): boolean {
  const root = ports.readEditorRoot();
  if (root === undefined || ports.isComposing() || ports.isInputStopped()) {
    return false;
  }
  const range = readSelectionRange(root);
  // The inside of pre holds code text, and comment bodies and replies are comment entries, so no image goes
  // there. For a range, look at the start, where the caret remains after the delete.
  if (range === undefined || isFormattingExcluded(range.startContainer, root)) {
    return false;
  }

  const image = buildImage(values, root.ownerDocument, ports.documentUri, ports.resourceRootUri);
  return ports.runCommandEdit(IMAGE_INSERT_EDIT_KIND, () => insertAtSelection(ports, root, image));
}

/**
 * Inside the attempt, ensures a target block and deletes the range, then inserts the image at the caret.
 *
 * It returns whether it changed the tree instead of letting exceptions out, so that whatever was changed
 * before a failure is still closed as an edit. Aborting would make the display and the saved content
 * disagree.
 *
 * @param ports The ports of the image insertion.
 * @param root The editor root.
 * @param image The image to insert.
 * @returns Whether the tree was changed.
 */
function insertAtSelection(ports: ImageInsertPorts, root: Element, image: Element): boolean {
  const progress: BlockRewriteProgress = { changed: false };
  try {
    const range = readSelectionRange(root);
    if (range === undefined) {
      return false;
    }
    // The range delete, and ensuring a target block outside a block (creating or wrapping a paragraph), can
    // change the tree. Record the change before calling them, so the change can be closed even if an
    // exception is thrown partway.
    if (!range.collapsed || findBlock(range.startContainer, root) === undefined) {
      progress.changed = true;
    }
    // A target block cannot be ensured only when ensuring stopped before touching the tree, so close with
    // an abort.
    if (ports.deleteRange(range) === undefined) {
      return false;
    }

    // The delete and the ensuring move the caret, so read the selection again. If the caret after the
    // delete is where an image cannot go, insert no image and close only what the delete changed.
    const caret = readSelectionRange(root);
    if (caret === undefined || isFormattingExcluded(caret.startContainer, root)) {
      return progress.changed;
    }
    // Read before inserting. After insertion the image is there, so the block is no longer judged empty.
    const block = findBlock(caret.startContainer, root);
    const placeholderOnly = block !== undefined && isEmptyBlock(block);

    progress.changed = true;
    caret.insertNode(image);
    if (placeholderOnly) {
      // The placeholder that gave the empty line its height is not needed once the image is in. Content
      // under table cells is not tidied on save either, so leaving it would put a br in the saved content.
      block.querySelector(':scope > br')?.remove();
    }
    // Place it before the attempt closes. Placed after, the caret would not be recorded in the endpoint
    // after the edit.
    caret.setStartAfter(image);
    caret.collapse(true);
    placeCaret(caret.startContainer, caret.startOffset);
  } catch (error) {
    ports.reportDiagnostic(`Could not insert the image: ${String(error)}`);
  }
  return progress.changed;
}
