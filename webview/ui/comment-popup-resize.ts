import { COMMENT_POPUP_MIN_WIDTH, COMMENT_POPUP_WIDTH_META_NAME, parseCommentPopupWidth } from '../../common/index';

/**
 * The custom property on the root element that holds the width the user dragged the comment popup to. Kept identical
 * to the spelling in the stylesheet, which falls back to the default width while it is not set.
 */
export const COMMENT_POPUP_WIDTH_PROPERTY = '--ahve-comment-popup-width';

/**
 * The attribute put on the root element while the popup edge is being dragged. Kept identical to the spelling in the
 * stylesheet, which keeps the resize cursor and stops text selection everywhere until the drag ends.
 */
export const COMMENT_POPUP_RESIZING_ATTRIBUTE = 'data-comment-popup-resizing';

/** The class of the strip along the popup's right edge that is dragged to resize it. Spelled as in the stylesheet. */
export const COMMENT_POPUP_RESIZER_CLASS = 'comment-popup-resizer';

/**
 * The custom property on the strip that holds the height of the popup's visible area. Kept identical to the spelling
 * in the stylesheet, which draws the strip that tall.
 */
export const COMMENT_POPUP_RESIZER_HEIGHT_PROPERTY = '--comment-popup-resizer-height';

// The room the stylesheet keeps between the popup and the right edge of the view, in em of the popup's font size.
const VIEW_MARGIN_EM = 1;

/** Ports of the resize strip. None of them holds a value; each is called when needed. */
export interface CommentPopupResizePorts {
  /** Places the open popup again, so that a new width keeps it inside the view. Does nothing while it is closed. */
  place(): void;

  /**
   * Hands the width on, so that the views created afterwards start with it.
   *
   * @param width The width after resizing, in whole CSS pixels.
   */
  saveWidth(width: number): void;
}

/** A drag of the popup edge in progress. */
interface ResizeDrag {
  readonly pointerId: number;
  /** The pointer's horizontal position when the drag started. */
  readonly startX: number;
  /** The popup's drawn width when the drag started. */
  readonly startWidth: number;
  /**
   * The width held when the drag started. It differs from the drawn width when the stylesheet bounds a stored width,
   * so it is what the end of the drag compares against.
   */
  readonly heldWidth: number | undefined;
  /** Whether the pointer has left the press horizontally at least once. */
  moved: boolean;
}

/**
 * The strip along the comment popup's right edge, dragged to set the width of every popup in the view.
 *
 * The width lives on the root element rather than on the popup, so that the next comment opens at it too. One per
 * view; not recreated on document replacement.
 */
export class CommentPopupResize {
  // The width the user dragged it to. `undefined` keeps the stylesheet's default.
  private width: number | undefined;

  private drag: ResizeDrag | undefined;

  /**
   * @param view The view's window.
   * @param element The popup element.
   * @param resizer The strip along the popup's right edge.
   * @param ports The ports of the strip.
   */
  constructor(
    private readonly view: Window,
    private readonly element: HTMLElement,
    private readonly resizer: HTMLElement,
    private readonly ports: CommentPopupResizePorts,
  ) {}

  /**
   * Applies the width the view starts with, without handing it on: it came from the host in the first place.
   *
   * @param width The width, or `undefined` to keep the default.
   */
  restoreWidth(width: number | undefined): void {
    if (width !== undefined) {
      this.applyWidth(width);
    }
  }

  /**
   * Starts dragging the popup edge with the primary button.
   *
   * The pointer is captured, so that the drag goes on while the pointer runs over the body or outside the view.
   *
   * @param event The press on the resize strip.
   */
  handleResizeStart(event: PointerEvent): void {
    if (event.button !== 0 || this.element.hidden || this.drag !== undefined) {
      return;
    }
    this.drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: this.element.getBoundingClientRect().width,
      heldWidth: this.width,
      moved: false,
    };
    this.resizer.setPointerCapture(event.pointerId);
    this.view.document.documentElement.setAttribute(COMMENT_POPUP_RESIZING_ATTRIBUTE, '');
  }

  /**
   * Follows the pointer during a drag, within the narrowest width and the room the view leaves, and places the popup
   * again, because a new width changes its height and how far it has to be pulled in from the right edge.
   *
   * The width follows the distance moved rather than the pointer's position, so that the edge does not jump to the
   * pointer when the press lands a little off it.
   *
   * @param event The movement.
   */
  handleResizeMove(event: PointerEvent): void {
    const drag = this.drag;
    if (drag?.pointerId !== event.pointerId) {
      return;
    }
    // Until the pointer first leaves the press horizontally, the held width stays, so that merely pressing the edge
    // does not replace a stored width with the narrower one the stylesheet draws.
    if (!drag.moved && event.clientX === drag.startX) {
      return;
    }
    drag.moved = true;
    this.applyWidth(clampCommentPopupWidth(drag.startWidth + event.clientX - drag.startX, this.readMaxWidth()));
    this.ports.place();
  }

  /**
   * Ends a drag and hands the width on when it changed, so that the width the view now holds is the one the next view
   * starts with.
   *
   * @param event The release, cancellation or loss of capture.
   */
  handleResizeEnd(event: PointerEvent): void {
    const drag = this.drag;
    if (drag?.pointerId !== event.pointerId) {
      return;
    }
    this.drag = undefined;
    this.view.document.documentElement.removeAttribute(COMMENT_POPUP_RESIZING_ATTRIBUTE);
    if (this.resizer.hasPointerCapture(drag.pointerId)) {
      this.resizer.releasePointerCapture(drag.pointerId);
    }
    if (this.width !== undefined && this.width !== drag.heldWidth) {
      this.ports.saveWidth(this.width);
    }
  }

  /**
   * Makes the strip as tall as the popup's visible area, so that it covers the whole right edge however long the
   * thread is. The stylesheet keeps it at the top of that area while the thread scrolls.
   */
  handlePopupResize(): void {
    this.resizer.style.setProperty(COMMENT_POPUP_RESIZER_HEIGHT_PROPERTY, `${String(this.element.clientHeight)}px`);
  }

  /**
   * Returns the widest the popup can be drawn: the view without its scrollbar, less the margin the stylesheet keeps.
   */
  private readMaxWidth(): number {
    const fontSize = Number.parseFloat(this.view.getComputedStyle(this.element).fontSize);
    return this.view.document.documentElement.clientWidth - fontSize * VIEW_MARGIN_EM;
  }

  /**
   * Sets the width the stylesheet draws every popup with.
   *
   * @param width The width in CSS pixels.
   */
  private applyWidth(width: number): void {
    this.width = width;
    this.view.document.documentElement.style.setProperty(COMMENT_POPUP_WIDTH_PROPERTY, `${String(width)}px`);
  }
}

/**
 * Places the resize strip inside the popup and subscribes to drags on it.
 *
 * Only a pointer resizes. The strip takes no focus, so Tab and Shift+Tab through the popup stop where they did, and it
 * is hidden from assistive technology, which would otherwise announce a control it cannot reach. The popup element
 * stays the same for the lifetime of the view, so call this only once on the first mount.
 *
 * @param view The view's window.
 * @param element The popup element.
 * @param ports The ports of the strip.
 * @param width The width the view starts with, or `undefined` to keep the default.
 * @returns The attached strip.
 */
export function attachCommentPopupResize(
  view: Window,
  element: HTMLElement,
  ports: CommentPopupResizePorts,
  width?: number,
): CommentPopupResize {
  const resizer = view.document.createElement('div');
  resizer.className = COMMENT_POPUP_RESIZER_CLASS;
  resizer.setAttribute('aria-hidden', 'true');
  // First, so that the stylesheet can stick it to the top of the visible area: a strip positioned against the popup
  // would scroll with the thread, and one moved down by the scroll would keep a shortened thread scrollable.
  element.prepend(resizer);

  const resize = new CommentPopupResize(view, element, resizer, ports);
  // A press does not move focus or the selection, so a reply being written keeps its caret, as with the sidebar's
  // strip. The pointer events still arrive, and the popup's own press handling does not take the strip for an entry.
  resizer.addEventListener('mousedown', (event) => event.preventDefault());
  resizer.addEventListener('pointerdown', (event) => resize.handleResizeStart(event));
  resizer.addEventListener('pointermove', (event) => resize.handleResizeMove(event));
  // The release normally ends the drag. Losing the capture covers the cases where no release arrives, such as the view
  // losing focus mid-drag.
  resizer.addEventListener('pointerup', (event) => resize.handleResizeEnd(event));
  resizer.addEventListener('pointercancel', (event) => resize.handleResizeEnd(event));
  resizer.addEventListener('lostpointercapture', (event) => resize.handleResizeEnd(event));
  // The visible area changes with the thread, the width, the room the placement leaves and a resized field, and only
  // the popup's own size covers all of them.
  new ResizeObserver(() => resize.handlePopupResize()).observe(element);
  resize.restoreWidth(width);
  return resize;
}

/**
 * Returns the width a drag ends up at, between the narrowest width and the widest the view allows.
 *
 * In a view too narrow for both, the narrowest width wins here, while the stylesheet still draws the popup inside the
 * view; the stored width then applies again once the view is wide enough.
 *
 * @param width The width the pointer asks for, in CSS pixels.
 * @param maxWidth The widest the popup can be drawn, in CSS pixels.
 * @returns The width in whole CSS pixels.
 */
export function clampCommentPopupWidth(width: number, maxWidth: number): number {
  return Math.round(Math.max(COMMENT_POPUP_MIN_WIDTH, Math.min(width, maxWidth)));
}

/**
 * Reads the width the host wrote into the view's document: the last one the user set for any file.
 *
 * @param document The view's document.
 * @returns The width, or `undefined` when the document carries none or an unreadable one.
 */
export function readEmbeddedCommentPopupWidth(document: Document): number | undefined {
  const content = document.head.querySelector<HTMLMetaElement>(`meta[name="${COMMENT_POPUP_WIDTH_META_NAME}"]`)
    ?.content;
  // An empty content would read as 0 and be raised to the narrowest width instead of keeping the default.
  if (content === undefined || content.trim() === '') {
    return undefined;
  }
  return parseCommentPopupWidth(Number(content));
}
