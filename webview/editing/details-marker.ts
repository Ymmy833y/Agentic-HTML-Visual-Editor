import type { BlockCommandPorts } from './block-command';
import { findDetailsTitle, isDetailsTitle } from './details-section';
import { toggleDetailsSection } from './details-toggle';
import type { DiagnosticReporter } from './input-dispatcher';

/** The collapsible section a pointer operation hit, and whether that position is in the marker area. */
export interface MarkerHit {
  /** The collapsible section to toggle. */
  readonly section: Element;
  /** `true` if the position is inside the marker area. */
  readonly onMarker: boolean;
}

/**
 * Reads the toggle target and whether it is in the marker area, from a pointer operation's target and
 * coordinates.
 *
 * Changes neither the tree nor the selection. Returns a value only when the target is a title, or is
 * a collapsible section itself that displays the default summary.
 *
 * @param root The editor root.
 * @param event The mouse event.
 * @returns The collapsible section hit and whether it is in the area. `undefined` if the target is
 * not one this function handles.
 */
export function readMarkerHit(root: Element, event: MouseEvent): MarkerHit | undefined {
  const target = event.target;
  if (!(target instanceof Element) || !root.contains(target)) {
    return undefined;
  }

  if (isDetailsTitle(target)) {
    const section = target.parentElement;
    return section === null ? undefined : { section, onMarker: isOnTitleMarker(target, event) };
  }

  // The default summary is not in the tree, so it is recognized instead by the target being the
  // collapsible section itself.
  if (target.localName === 'details' && findDetailsTitle(target) === undefined) {
    return { section: target, onMarker: isOnDefaultSummary(target, event) };
  }
  return undefined;
}

/**
 * Stops caret placement and focus movement only for a press inside the marker area.
 *
 * Outside the area, the default is left alone, so extending a selection inside the body is not
 * disrupted.
 *
 * @param root The editor root.
 * @param event The mouse press.
 * @param reportDiagnostic The diagnostic reporter for maintainers.
 */
export function handleDetailsPointerDown(
  root: Element,
  event: MouseEvent,
  reportDiagnostic: DiagnosticReporter,
): void {
  if (event.button !== 0) {
    return;
  }

  try {
    if (readMarkerHit(root, event)?.onMarker === true) {
      event.preventDefault();
    }
  } catch (error) {
    // Letting the exception escape the listener would leave maintainers unable to trace why the press
    // had no effect. The default is left alone, so this proceeds as an ordinary press where the
    // browser places the caret.
    reportDiagnostic(`Failed to determine the collapsible section's marker area: ${String(error)}`);
  }
}

/**
 * Routes clicks on the title and the default summary to nothing but toggling and caret placement.
 *
 * The browser's default toggle changes `open` outside any edit attempt, so it is always stopped
 * before the area check. Even if the check fails, the toggle does not happen because it was already
 * stopped first.
 *
 * @param ports The block command ports.
 * @param root The editor root.
 * @param event The mouse click.
 */
export function handleDetailsClick(
  ports: BlockCommandPorts,
  root: Element,
  event: MouseEvent,
): void {
  if (event.button !== 0) {
    return;
  }

  const target = event.target;
  if (!(target instanceof Node) || findClickedSection(root, target) === undefined) {
    return;
  }
  event.preventDefault();

  // A click with no coordinates (the synthetic click that Enter/Space fires on a focused title) is
  // treated as outside the area, to prevent it from closing the section right after opening it with
  // Enter on the title.
  if (event.detail === 0) {
    return;
  }

  let hit: MarkerHit | undefined;
  try {
    hit = readMarkerHit(root, event);
  } catch (error) {
    ports.reportDiagnostic(`Failed to determine the collapsible section's marker area: ${String(error)}`);
    return;
  }

  if (hit?.onMarker === true) {
    toggleDetailsSection(ports, hit.section);
  }
}

/**
 * Returns the collapsible section whose default toggle a click would trigger.
 *
 * Clicking a link or an annotation inside the title also triggers the default toggle, so this walks
 * up the ancestors to find the title.
 *
 * @param root The editor root.
 * @param target The click target.
 * @returns The collapsible section whose default toggle would trigger. `undefined` if none would.
 */
function findClickedSection(root: Element, target: Node): Element | undefined {
  const element = target instanceof Element ? target : target.parentElement;
  if (element === null || !root.contains(element)) {
    return undefined;
  }

  if (element.localName === 'details' && findDetailsTitle(element) === undefined) {
    return element;
  }

  let current: Element | null = element;
  while (current !== null && current !== root) {
    if (current.localName === 'summary') {
      return isDetailsTitle(current) ? current.parentElement ?? undefined : undefined;
    }
    current = current.parentElement;
  }
  return undefined;
}

/**
 * Determines whether coordinates are inside the title's marker area.
 *
 * The area's width is read from the computed leading inline padding rather than hardcoded, so it does
 * not go stale on its own when the padding changes.
 *
 * @param title The title.
 * @param event The mouse event.
 * @returns `true` if inside the area.
 */
function isOnTitleMarker(title: Element, event: MouseEvent): boolean {
  const view = title.ownerDocument.defaultView;
  if (view === null) {
    return false;
  }

  const style = view.getComputedStyle(title);
  const width = readLength(style.paddingInlineStart);
  if (width <= 0) {
    return false;
  }

  const box = title.getBoundingClientRect();
  // Vertically, only the first line counts. No marker is visible at the leading edge of the second
  // line onward, and toggling there would be an unintended operation.
  if (event.clientY < box.top || event.clientY > readFirstLineBottom(title, box)) {
    return false;
  }

  return style.direction === 'rtl'
    ? event.clientX >= box.right - width
    : event.clientX <= box.left + width;
}

/**
 * Returns the bottom edge of the title's first line.
 *
 * @param title The title.
 * @param box The title's bounding rect.
 * @returns The bottom edge of the first line. The title's own bottom edge if no rect is available (an
 * empty title is one line).
 */
function readFirstLineBottom(title: Element, box: DOMRect): number {
  const contents = title.ownerDocument.createRange();
  contents.selectNodeContents(title);
  return contents.getClientRects()[0]?.bottom ?? box.bottom;
}

/**
 * Determines whether coordinates are inside the default summary's line, for a collapsible section
 * with no title.
 *
 * The default summary is not in the tree, so its line is taken as running from the top of the content
 * area to the top of the first child element.
 *
 * @param section The collapsible section.
 * @param event The mouse event.
 * @returns `true` if inside the default summary's line.
 */
function isOnDefaultSummary(section: Element, event: MouseEvent): boolean {
  const view = section.ownerDocument.defaultView;
  if (view === null) {
    return false;
  }

  const style = view.getComputedStyle(section);
  const box = section.getBoundingClientRect();
  const top = box.top + readLength(style.borderTopWidth) + readLength(style.paddingTop);
  const first = section.firstElementChild;
  const bottom = first === null
    ? box.bottom - readLength(style.borderBottomWidth) - readLength(style.paddingBottom)
    : first.getBoundingClientRect().top;

  const left = box.left + readLength(style.borderLeftWidth) + readLength(style.paddingLeft);
  const right = box.right - readLength(style.borderRightWidth) - readLength(style.paddingRight);
  return event.clientY >= top && event.clientY <= bottom
    && event.clientX >= left && event.clientX <= right;
}

/**
 * Returns a computed-value length as a number.
 *
 * @param value The computed value.
 * @returns The length. 0 if it cannot be read.
 */
function readLength(value: string): number {
  const length = Number.parseFloat(value);
  return Number.isFinite(length) ? length : 0;
}
