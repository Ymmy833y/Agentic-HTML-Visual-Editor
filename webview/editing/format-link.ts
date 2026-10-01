import {
  CREATED_FORMAT_TAG_NAME,
  FORMAT_TAG_NAMES,
  INLINE_FORMAT,
  isBlockLevelElement,
  isFormatElement,
} from './inline-format';
import { unwrapAncestorFormats, unwrapDescendantFormats, wrapSegment } from './inline-wrap';
import type { FormatTarget } from './format-segment';

/**
 * Returns the single link that contains the whole selection.
 *
 * The ancestors are walked even for a bare caret, because changing or removing a link does not need a
 * range.
 *
 * @param target The format target.
 * @param root The editor root.
 * @returns The link containing the whole selection, or `undefined` when there is no target, the
 * selection is outside a link, or it spans more than one link.
 */
export function findEnclosingLink(target: FormatTarget, root: Element): Element | undefined {
  if (target.kind === 'none') {
    return undefined;
  }
  if (target.kind === 'caret') {
    return findLinkAncestor(target.caret.startContainer, root);
  }

  const [first, ...rest] = target.segments;
  if (first === undefined) {
    return undefined;
  }
  const link = findLinkAncestor(first.range.startContainer, root);
  if (link === undefined) {
    return undefined;
  }
  for (const segment of rest) {
    if (findLinkAncestor(segment.range.startContainer, root) !== link) {
      return undefined;
    }
  }
  return link;
}

/**
 * Turns the format target into a link.
 *
 * When the selection fits inside a single link, the destination of the whole link is changed even if the
 * range covers only part of it. That matches a bare caret taking the whole link as its target, so the
 * result does not vary within the same link.
 *
 * @param url The destination. The caller has validated it and it is not empty.
 * @param target The format target.
 * @param root The editor root.
 * @returns The touched blocks. Empty when nothing was changed.
 */
export function applyLink(url: string, target: FormatTarget, root: Element): Element[] {
  const enclosing = findEnclosingLink(target, root);
  if (enclosing !== undefined) {
    if (enclosing.getAttribute('href') === url) {
      return [];
    }
    enclosing.setAttribute('href', url);
    const block = findBlockAncestor(enclosing, root);
    return block === undefined ? [] : [block];
  }
  if (target.kind !== 'segments') {
    return [];
  }

  const touched: Element[] = [];
  // Work from the last format segment backwards. Splitting a link at a boundary moves the content after
  // it into the split-off element, so working forwards would shift where the content that the later
  // format segments point at sits.
  for (const segment of [...target.segments].reverse()) {
    // Remove any intersecting existing link first. Keeping it would nest one link inside another.
    unwrapDescendantFormats(segment, FORMAT_TAG_NAMES[INLINE_FORMAT.link]);
    unwrapAncestorFormats(segment, FORMAT_TAG_NAMES[INLINE_FORMAT.link]);

    const document = segment.range.startContainer.ownerDocument;
    if (document === null) {
      continue;
    }
    const anchor = document.createElement(CREATED_FORMAT_TAG_NAME[INLINE_FORMAT.link]);
    // No attribute other than the destination is set.
    anchor.setAttribute('href', url);
    if (wrapSegment(segment, anchor) && segment.block !== undefined) {
      touched.push(segment.block);
    }
  }
  return touched;
}

/**
 * Removes the link from the format target.
 *
 * @param target The format target.
 * @param root The editor root.
 * @returns The touched blocks. Empty when nothing was changed.
 */
export function removeLink(target: FormatTarget, root: Element): Element[] {
  const enclosing = findEnclosingLink(target, root);
  if (enclosing !== undefined) {
    const block = findBlockAncestor(enclosing, root);
    enclosing.replaceWith(...enclosing.childNodes);
    return block === undefined ? [] : [block];
  }
  if (target.kind !== 'segments') {
    return [];
  }

  const touched: Element[] = [];
  // Work from the last format segment backwards. Splitting a link at a boundary moves the content after
  // it into the split-off element, so working forwards would shift where the content that the later
  // format segments point at sits.
  for (const segment of [...target.segments].reverse()) {
    const inside = unwrapDescendantFormats(segment, FORMAT_TAG_NAMES[INLINE_FORMAT.link]);
    const outside = unwrapAncestorFormats(segment, FORMAT_TAG_NAMES[INLINE_FORMAT.link]);
    if ((inside || outside) && segment.block !== undefined) {
      touched.push(segment.block);
    }
  }
  return touched;
}

/**
 * Finds the innermost link containing a node.
 *
 * @param node The node to start from.
 * @param root The editor root. The walk upwards stops here.
 * @returns The link that was found, or `undefined` when there is none.
 */
function findLinkAncestor(node: Node, root: Element): Element | undefined {
  let current: Element | null = node instanceof Element ? node : node.parentElement;
  while (current !== null && current !== root) {
    if (isFormatElement(current, INLINE_FORMAT.link)) {
      return current;
    }
    current = current.parentElement;
  }
  return undefined;
}

/**
 * Finds the innermost block-level element containing an element.
 *
 * @param element The element to start from.
 * @param root The editor root.
 * @returns The block that was found, or `undefined` when the element sits directly inside the editor root.
 */
function findBlockAncestor(element: Element, root: Element): Element | undefined {
  let current: Element | null = element.parentElement;
  while (current !== null && current !== root) {
    if (isBlockLevelElement(current)) {
      return current;
    }
    current = current.parentElement;
  }
  return undefined;
}
