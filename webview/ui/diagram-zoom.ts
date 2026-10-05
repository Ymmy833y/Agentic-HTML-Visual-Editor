import type { Localizer } from '../../common/index';
import { isDiagramSource } from '../diagram/diagram-source';
import { DIAGRAM_MARK_NAME, DIAGRAM_MARK_NAMESPACE, DIAGRAM_ZOOM_LEVELS } from '../diagram/diagram-view';
import { readCodeBlockCopyPlacement } from './code-block-copy';
import { createItemIcon } from './toolbar';

/** The ID of the element that holds the zoom buttons. The bundled stylesheet and E2E look it up with the same spelling. */
export const DIAGRAM_ZOOM_ELEMENT_ID = 'editor-diagram-zoom';

/** What a zoom button does: one step up, one step down, or back to 100%. */
export type DiagramZoomAction = 'zoomIn' | 'zoomOut' | 'reset';

// A magnifier: the lens and the handle.
const LENS_PATH = 'M17 10.5a6.5 6.5 0 1 1-13 0a6.5 6.5 0 1 1 13 0Z M15.2 15.2L20 20';

// The icons of the buttons, drawn in a 24×24 view box. Reset shows four corners, the usual size of the frame.
const ZOOM_ICON_PATH: Readonly<Record<DiagramZoomAction, string>> = {
  zoomIn: `${LENS_PATH} M10.5 7.5v6 M7.5 10.5h6`,
  zoomOut: `${LENS_PATH} M7.5 10.5h6`,
  reset: 'M4 9V4h5 M15 4h5v5 M20 15v5h-5 M9 20H4v-5',
};

// The buttons in the order they appear.
const ZOOM_ACTIONS: readonly DiagramZoomAction[] = ['zoomIn', 'zoomOut', 'reset'];

/**
 * Ports of the zoom buttons.
 *
 * They hold no values and are read on every call, because the diagram view, the tooltip and the search panel belong to
 * other parts of the view.
 */
export interface DiagramZoomPorts {
  /** Resolves the button names. */
  readonly localizer: Localizer;

  /**
   * Hands a button and its name to the tooltip, so that the name is shown when the pointer rests on it.
   *
   * @param element The button.
   * @param label The resolved name.
   */
  registerTooltip(element: Element, label: string): void;

  /**
   * Reads the top of the area the buttons can go in: the bottom of the toolbar's strip and, while it is open, of the
   * search panel.
   *
   * @returns In viewport coordinates. 0 if there is no toolbar and the search panel is closed.
   */
  readAreaTop(): number;

  /**
   * Reads the zoom level of a diagram.
   *
   * @param block The diagram source block.
   * @returns The factor of its usual size.
   */
  readZoom(block: Element): number;

  /**
   * Shows a diagram at a zoom level.
   *
   * @param block The diagram source block.
   * @param level The factor of its usual size.
   */
  zoomDiagram(block: Element, level: number): void;
}

/**
 * Returns the zoom level one button press leads to. At the ends of the levels, the level stays.
 *
 * @param current The current zoom level.
 * @param action The button pressed.
 * @returns The next zoom level.
 */
export function readNextZoomLevel(current: number, action: DiagramZoomAction): number {
  if (action === 'reset') {
    return 1;
  }
  if (action === 'zoomIn') {
    return DIAGRAM_ZOOM_LEVELS.find((level) => level > current) ?? current;
  }
  return [...DIAGRAM_ZOOM_LEVELS].reverse().find((level) => level < current) ?? current;
}

/**
 * Returns the drawn diagram that contains the target. A diagram that shows an error or an empty card, or that is not
 * drawn yet, has no picture to zoom, so it does not count.
 *
 * @param target The target of a pointer event.
 * @param root The editor root.
 * @returns The diagram source block, or `undefined`.
 */
export function findZoomableDiagram(target: EventTarget | null, root: Element): Element | undefined {
  if (!(target instanceof Node)) {
    return undefined;
  }
  const element = target instanceof Element ? target : target.parentElement;
  const block = element?.closest('pre') ?? null;
  return block !== null
    && root.contains(block)
    && isDiagramSource(block)
    && block.hasAttributeNS(DIAGRAM_MARK_NAMESPACE, DIAGRAM_MARK_NAME)
    ? block
    : undefined;
}

/**
 * Shows the zoom buttons at the top right of the drawn diagram under the pointer, and changes its zoom level when one
 * is pressed.
 *
 * The buttons live outside the editor root, so they never enter the tree or the body output, and a press on them is
 * not a click on the diagram. One per view, not recreated on document replacement.
 */
export class DiagramZoom {
  // The diagram the buttons are shown for. `undefined` while hidden.
  private block: Element | undefined;

  /**
   * @param root The editor root.
   * @param bar The element that holds the buttons.
   * @param ports The ports of the buttons.
   */
  constructor(
    private readonly root: HTMLElement,
    private readonly bar: HTMLElement,
    private readonly ports: DiagramZoomPorts,
  ) {}

  /**
   * On a pointer move over the editor root, shows the buttons for the diagram under the pointer, and hides them
   * elsewhere. Nothing is shown while the primary button is held, so that the buttons do not take over a selection
   * being extended.
   *
   * @param event The pointer move.
   */
  handlePointerMove(event: MouseEvent): void {
    const block = (event.buttons & 1) === 0 ? findZoomableDiagram(event.target, this.root) : undefined;
    if (block === undefined) {
      this.hide();
      return;
    }
    this.block = block;
    this.bar.hidden = false;
    this.place(block);
  }

  /**
   * When the pointer leaves the editor root, hides the buttons unless the pointer moved onto them. They lie over the
   * diagram but outside the editor root, so moving onto them also leaves the editor root.
   *
   * @param event The leave of the editor root.
   */
  handleRootLeave(event: MouseEvent): void {
    if (contains(this.bar, event.relatedTarget)) {
      return;
    }
    this.hide();
  }

  /**
   * When the pointer leaves the buttons, hides them unless the pointer went back into their diagram.
   *
   * @param event The leave of the buttons.
   */
  handleBarLeave(event: MouseEvent): void {
    const block = this.block;
    if (block !== undefined && contains(block, event.relatedTarget)) {
      return;
    }
    this.hide();
  }

  /**
   * On a press anywhere but the buttons, hides them. The next pointer move shows them again.
   *
   * @param event The press.
   */
  handlePointerDown(event: Event): void {
    if (contains(this.bar, event.target)) {
      return;
    }
    this.hide();
  }

  /** On key input, hides the buttons. Typing can move the diagram away from under a pointer that stays still. */
  handleKeyDown(): void {
    this.hide();
  }

  /** On a scroll or a change of the view size, places the shown buttons again at the top right of the visible part. */
  handleViewportChange(): void {
    const block = this.block;
    if (block === undefined) {
      return;
    }
    if (!this.root.contains(block)) {
      this.hide();
      return;
    }
    this.place(block);
  }

  /** On a document replacement, hides the buttons. Their diagram went away with the old tree. */
  handleMountCompleted(): void {
    this.hide();
  }

  /**
   * On a press of a button, moves the diagram one step, or back to 100%. A diagram that left the tree without a key or
   * a replacement is not zoomed.
   *
   * @param action The button pressed.
   */
  handlePress(action: DiagramZoomAction): void {
    const block = this.block;
    if (block === undefined || !this.root.contains(block)) {
      this.hide();
      return;
    }
    this.ports.zoomDiagram(block, readNextZoomLevel(this.ports.readZoom(block), action));
    // The diagram changes height with its zoom level, so the buttons follow its top right again.
    this.place(block);
  }

  /** Hides the buttons. Safe to call while they are hidden. */
  hide(): void {
    this.block = undefined;
    this.bar.hidden = true;
  }

  /**
   * Places the buttons against the diagram's current rectangle and the top of the area they can go in.
   *
   * @param block The diagram source block.
   */
  private place(block: Element): void {
    const size = this.bar.getBoundingClientRect();
    const position = readCodeBlockCopyPlacement(
      block.getBoundingClientRect(),
      { width: size.width, height: size.height },
      this.ports.readAreaTop(),
    );
    this.bar.style.left = `${position.left}px`;
    this.bar.style.top = `${position.top}px`;
  }
}

/**
 * Places the hidden zoom buttons right after the editor root and attaches their listeners.
 *
 * Called only once, on the first mount, whether or not there is a toolbar. The editor root stays the same element
 * across document replacements, so nothing is reattached.
 *
 * @param view The view's window.
 * @param root The editor root.
 * @param ports The ports of the buttons.
 * @returns The attached zoom buttons.
 */
export function attachDiagramZoom(view: Window, root: HTMLElement, ports: DiagramZoomPorts): DiagramZoom {
  const document = view.document;
  const bar = document.createElement('div');
  bar.id = DIAGRAM_ZOOM_ELEMENT_ID;
  bar.hidden = true;
  const zoom = new DiagramZoom(root, bar, ports);
  for (const action of ZOOM_ACTIONS) {
    const button = document.createElement('button');
    button.type = 'button';
    // They appear only while the pointer rests on a diagram, so the keyboard does not stop at them.
    button.tabIndex = -1;
    const label = ports.localizer.getMessage(`diagramZoom.${action}`);
    // An icon alone is not read aloud, so the resolved message becomes the accessible name. No title is set, or the
    // browser's own tooltip would show up next to the shared one.
    button.setAttribute('aria-label', label);
    button.append(createItemIcon(document, ZOOM_ICON_PATH[action]));
    ports.registerTooltip(button, label);
    // Pressing must not take focus away from the editor root, or the caret and the selection would be lost.
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', () => zoom.handlePress(action));
    bar.append(button);
  }
  // Inside the editor root they would appear in the body output. Right after it, they come before the floating surfaces
  // appended later, so they stay behind them at the same stacking level.
  root.after(bar);

  bar.addEventListener('mouseleave', (event) => zoom.handleBarLeave(event));
  root.addEventListener('mousemove', (event) => zoom.handlePointerMove(event));
  root.addEventListener('mouseleave', (event) => zoom.handleRootLeave(event));
  // Presses and keys are received in the capture phase, so that they hide the buttons even when another listener stops
  // propagation.
  document.addEventListener('pointerdown', (event) => zoom.handlePointerDown(event), true);
  document.addEventListener('keydown', () => zoom.handleKeyDown(), true);
  // A scroll in an element inside does not bubble out, so it is received in the capture phase.
  view.addEventListener('scroll', () => zoom.handleViewportChange(), true);
  view.addEventListener('resize', () => zoom.handleViewportChange());
  return zoom;
}

/**
 * Returns whether an element contains a target.
 *
 * @param element The element.
 * @param target The target of an event, or `null`.
 * @returns `true` when the target is the element or inside it.
 */
function contains(element: Element, target: EventTarget | null): boolean {
  return target instanceof Node && element.contains(target);
}
