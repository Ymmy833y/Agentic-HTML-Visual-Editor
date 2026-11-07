import { writeClipboardContent } from '../editing/clipboard-copy';
import { createRangesCopyContent } from '../editing/copy-html';
import type { CopyRange } from '../editing/copy-html';

/** Ports for copying in the comment popup. Holds no values and reads them on every call. */
export interface CommentPopupCopyPorts {
  /**
   * Returns the entry texts drawn in the popup, in document order. The display of an empty entry is not one.
   *
   * @returns The entry texts.
   */
  readEntryTexts(): readonly Element[];

  /**
   * Records one diagnostic line for maintainers. Not used for user notifications.
   *
   * @param detail The line to record.
   */
  reportDiagnostic(detail: string): void;
}

/**
 * Cuts a range into the parts that lie in each entry text.
 *
 * The names, the times and the buttons between the entries are not entry texts, so they drop out.
 *
 * @param range The range of the selection.
 * @param texts The entry texts, in document order.
 * @returns One range per entry text the range covers, in the same order, each held by its entry text.
 */
export function readEntryRanges(range: Range, texts: readonly Element[]): CopyRange[] {
  const ranges: CopyRange[] = [];
  for (const text of texts) {
    if (!range.intersectsNode(text)) {
      continue;
    }
    const part = text.ownerDocument.createRange();
    part.selectNodeContents(text);
    if (range.compareBoundaryPoints(range.START_TO_START, part) > 0) {
      part.setStart(range.startContainer, range.startOffset);
    }
    if (range.compareBoundaryPoints(range.END_TO_END, part) < 0) {
      part.setEnd(range.endContainer, range.endOffset);
    }
    if (!part.collapsed) {
      ranges.push({ range: part, root: text });
    }
  }
  return ranges;
}

/**
 * On a copy of a selection that lies in the popup and covers an entry text, writes only what the entries hold, and
 * prevents the default.
 *
 * The default copy carries the look of the popup, such as its dark background, into the HTML, and pasting it brings
 * that look along. A copy already taken by a field, a selection that reaches outside the popup, and one that covers
 * no entry text are left alone.
 *
 * @param event The copy event.
 * @param element The popup element.
 * @param ports The ports.
 */
export function handleCommentPopupCopy(event: ClipboardEvent, element: Element, ports: CommentPopupCopyPorts): void {
  if (event.defaultPrevented || event.clipboardData === null) {
    return;
  }
  const selection = element.ownerDocument.getSelection();
  if (selection === null || selection.rangeCount === 0) {
    return;
  }
  const range = selection.getRangeAt(0);
  if (range.collapsed || !element.contains(range.startContainer) || !element.contains(range.endContainer)) {
    return;
  }
  let ranges: CopyRange[];
  try {
    ranges = readEntryRanges(range, ports.readEntryTexts());
  } catch (error) {
    ports.reportDiagnostic(`Could not read the entries to copy from the comment popup: ${String(error)}`);
    return;
  }
  if (ranges.length === 0) {
    return;
  }
  // Prevented even when the content could not be created, rather than falling back to a copy with the popup's look.
  event.preventDefault();
  const content = createRangesCopyContent(ranges, (detail) => ports.reportDiagnostic(detail));
  if (content !== undefined) {
    writeClipboardContent(event, content);
  }
}

/**
 * Attaches the copy listener to the popup element.
 *
 * The popup element stays the same for the lifetime of the view, so call this only once on the first mount. The
 * listener runs after those of the fields inside the popup, which take a copy of their own selection first.
 *
 * @param element The popup element.
 * @param ports The ports.
 */
export function attachCommentPopupCopy(element: HTMLElement, ports: CommentPopupCopyPorts): void {
  element.addEventListener('copy', (event) => handleCommentPopupCopy(event, element, ports));
}
