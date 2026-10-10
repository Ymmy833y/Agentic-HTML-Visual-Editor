import { VIEW_TO_HOST_MESSAGE_TYPE } from '../../common/index';
import type { Localizer } from '../../common/index';
import { isDiagramSource } from '../diagram/diagram-source';
import { createCopyContent } from '../editing/copy-html';
import type { DiagnosticReporter } from '../editing/input-dispatcher';
import type { HostChannel } from '../messaging/host-channel';
import { COPIED_ICON_PATH, COPIED_ICON_TIMEOUT_MS, COPY_ICON_PATH } from './copy-button';
import { createItemIcon } from './toolbar';

/** The ID of the copy button element. The bundled stylesheet and E2E look it up with the same spelling. */
export const CODE_BLOCK_COPY_ELEMENT_ID = 'editor-code-block-copy';

/** Distance kept between the button and the top and right edges of the visible part of the code block (px). */
export const CODE_BLOCK_COPY_INSET_PX = 4;

/** A rectangle relative to the viewport. */
export interface CodeBlockCopyRect {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** The button's size. */
export interface CodeBlockCopySize {
  readonly width: number;
  readonly height: number;
}

/** Coordinates of the button, relative to the viewport. */
export interface CodeBlockCopyPosition {
  readonly left: number;
  readonly top: number;
}

/**
 * Ports of the code block copy button.
 *
 * They hold no values and are read on every call, because the host channel, the tooltip and the search panel belong to
 * other parts of the view.
 */
export interface CodeBlockCopyPorts {
  /** Resolves the button's name. */
  readonly localizer: Localizer;

  /**
   * Hands the button and its name to the tooltip, so that the name is shown when the pointer rests on it.
   *
   * @param element The button.
   * @param label The resolved name.
   */
  registerTooltip(element: Element, label: string): void;

  /**
   * Reads the top of the area the button can go in: the bottom of the toolbar's strip and, while it is open, of the
   * search panel. Both are drawn in front of the button.
   *
   * @returns In viewport coordinates. 0 if there is no toolbar and the search panel is closed.
   */
  readAreaTop(): number;

  /**
   * Sends the code text to the host. Does not wait for a response.
   *
   * @param text The code text.
   */
  requestCopy(text: string): void;

  /**
   * Records one diagnostic line for maintainers. Not used to notify the user.
   *
   * @param detail The line to record.
   */
  reportDiagnostic(detail: string): void;
}

/**
 * Shows a copy button at the top right of the code block under the pointer, and sends the code text to the host when
 * it is pressed.
 *
 * The button lives outside the editor root, so it never enters the tree or the body output. Only the host knows whether
 * the clipboard was written, so the check mark appears when the host reports success, never on the press itself. One
 * per view, not recreated on document replacement.
 */
export class CodeBlockCopy {
  // The code block the button is shown for. `undefined` while hidden.
  private block: Element | undefined;

  // The code block the check mark belongs to: the one the button was shown for when the success arrived.
  private copiedBlock: Element | undefined;

  // The wait that restores the clipboard icon. Only one is kept, so a success reported while the check mark is shown
  // starts the time over.
  private restoreTimer: number | undefined;

  /**
   * @param view The view's window, whose timers measure the time.
   * @param root The editor root.
   * @param button The copy button.
   * @param ports The ports of the button.
   */
  constructor(
    private readonly view: Window,
    private readonly root: HTMLElement,
    private readonly button: HTMLButtonElement,
    private readonly ports: CodeBlockCopyPorts,
  ) {}

  /**
   * On a pointer move over the editor root, shows the button for the code block under the pointer, and hides it
   * elsewhere.
   *
   * Nothing is shown while the primary button is held. The pointer is then selecting or dragging, and a button showing
   * up under it would take over the selection being extended.
   *
   * @param event The pointer move.
   */
  handlePointerMove(event: MouseEvent): void {
    const block = (event.buttons & 1) === 0 ? findCodeBlock(event.target, this.root) : undefined;
    if (block === undefined) {
      this.hide();
      return;
    }
    this.show(block);
  }

  /**
   * When the pointer leaves the editor root, hides the button unless the pointer moved onto it. The button lies over
   * the code block but outside the editor root, so moving onto it also leaves the editor root.
   *
   * @param event The leave of the editor root.
   */
  handleRootLeave(event: MouseEvent): void {
    if (contains(this.button, event.relatedTarget)) {
      return;
    }
    this.hide();
  }

  /**
   * When the pointer leaves the button, hides it unless the pointer went back into its code block.
   *
   * @param event The leave of the button.
   */
  handleButtonLeave(event: MouseEvent): void {
    const block = this.block;
    if (block !== undefined && contains(block, event.relatedTarget)) {
      return;
    }
    this.hide();
  }

  /**
   * On a press anywhere but the button, hides it, as a press hides a tooltip. The next pointer move shows it again.
   *
   * @param event The press.
   */
  handlePointerDown(event: Event): void {
    if (contains(this.button, event.target)) {
      return;
    }
    this.hide();
  }

  /** On key input, hides the button. Typing can move the code block away from under a pointer that stays still. */
  handleKeyDown(): void {
    this.hide();
  }

  /** On a scroll or a change of the view size, places the shown button again at the top right of the visible part. */
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

  /** On a document replacement, hides the button. Its code block went away with the old tree. */
  handleMountCompleted(): void {
    this.hide();
  }

  /**
   * On a press of the button, creates the code text of its code block and sends it to the host.
   *
   * The press itself leaves the focus and the selection where they were (the listener prevents the press default), and
   * creating the text changes neither the tree nor the selection. A code block that left the tree without a key or a
   * replacement is not copied.
   */
  handleClick(): void {
    const block = this.block;
    if (block === undefined || !this.root.contains(block)) {
      this.hide();
      return;
    }
    const text = readCodeBlockText(block, this.root, (detail) => this.ports.reportDiagnostic(detail));
    if (text === undefined) {
      return;
    }
    this.ports.requestCopy(text);
  }

  /**
   * Shows on the button that the code was written: replaces its icon with the check mark, then restores the clipboard
   * icon once the time has passed.
   */
  showCopied(): void {
    if (this.restoreTimer !== undefined) {
      this.view.clearTimeout(this.restoreTimer);
    }
    this.copiedBlock = this.block;
    this.setIcon(COPIED_ICON_PATH);
    this.restoreTimer = this.view.setTimeout(() => this.restoreIcon(), COPIED_ICON_TIMEOUT_MS);
  }

  /** Hides the button. Safe to call while it is hidden. */
  hide(): void {
    this.block = undefined;
    this.button.hidden = true;
  }

  /**
   * Shows the button for a code block, placed at the top right of its visible part.
   *
   * @param block The code block.
   */
  private show(block: Element): void {
    // The check mark tells that one particular code block was copied, so it does not move along to another one.
    if (this.restoreTimer !== undefined && block !== this.copiedBlock) {
      this.restoreIcon();
    }
    this.block = block;
    this.button.hidden = false;
    this.place(block);
  }

  /**
   * Places the button against the code block's current rectangle and the top of the area it can go in.
   *
   * @param block The code block.
   */
  private place(block: Element): void {
    // The rendered size rather than offsetWidth, which rounds to whole pixels and would shift the inset.
    const size = this.button.getBoundingClientRect();
    const position = readCodeBlockCopyPlacement(
      block.getBoundingClientRect(),
      { width: size.width, height: size.height },
      this.ports.readAreaTop(),
    );
    this.button.style.left = `${position.left}px`;
    this.button.style.top = `${position.top}px`;
  }

  /** Ends the check mark and draws the clipboard icon again. */
  private restoreIcon(): void {
    if (this.restoreTimer !== undefined) {
      this.view.clearTimeout(this.restoreTimer);
      this.restoreTimer = undefined;
    }
    this.setIcon(COPY_ICON_PATH);
  }

  /**
   * Draws the button's icon from a path.
   *
   * @param path The path drawn in a 24×24 view box.
   */
  private setIcon(path: string): void {
    this.button.replaceChildren(createItemIcon(this.button.ownerDocument, path));
  }
}

/**
 * Places the hidden copy button right after the editor root and attaches its listeners.
 *
 * Called only once, on the first mount, whether or not there is a toolbar. The editor root stays the same element
 * across document replacements, so nothing is reattached.
 *
 * @param view The view's window.
 * @param root The editor root.
 * @param ports The ports of the button.
 * @returns The attached copy button.
 */
export function attachCodeBlockCopy(view: Window, root: HTMLElement, ports: CodeBlockCopyPorts): CodeBlockCopy {
  const document = view.document;
  const button = document.createElement('button');
  button.id = CODE_BLOCK_COPY_ELEMENT_ID;
  button.type = 'button';
  button.hidden = true;
  // It appears only while the pointer rests on a code block, so the keyboard does not stop at it. The code can still be
  // selected and copied from the keyboard.
  button.tabIndex = -1;
  const label = ports.localizer.getMessage('codeBlockCopy.name');
  // An icon alone is not read aloud, so the resolved message becomes the accessible name. No title is set, or the
  // browser's own tooltip would show up next to the shared one.
  button.setAttribute('aria-label', label);
  button.append(createItemIcon(document, COPY_ICON_PATH));
  ports.registerTooltip(button, label);
  // Inside the editor root it would appear in the body output. Right after it, the button comes before the floating
  // surfaces appended later, so it stays behind them at the same stacking level.
  root.after(button);

  const copy = new CodeBlockCopy(view, root, button, ports);
  // Pressing must not take focus away from the editor root, or the caret and the selection would be lost.
  button.addEventListener('mousedown', (event) => event.preventDefault());
  button.addEventListener('click', () => copy.handleClick());
  button.addEventListener('mouseleave', (event) => copy.handleButtonLeave(event));
  root.addEventListener('mousemove', (event) => copy.handlePointerMove(event));
  root.addEventListener('mouseleave', (event) => copy.handleRootLeave(event));
  // Presses and keys are received in the capture phase, so that they hide the button even when another listener stops
  // propagation.
  document.addEventListener('pointerdown', (event) => copy.handlePointerDown(event), true);
  document.addEventListener('keydown', () => copy.handleKeyDown(), true);
  // A scroll in an element inside does not bubble out, so it is received in the capture phase.
  view.addEventListener('scroll', () => copy.handleViewportChange(), true);
  view.addEventListener('resize', () => copy.handleViewportChange());
  return copy;
}

/**
 * Returns the code block that contains the target: the innermost `pre` in the editor root, whether or not it holds a
 * `code`. Every `pre` counts as a code block, just as the block kind does, except a diagram source block: it is shown
 * as the drawn diagram, not as code, and its source is copied from its dialog.
 *
 * @param target The target of a pointer event.
 * @param root The editor root.
 * @returns The `pre`, or `undefined` when the target is not in a code block of the editor root.
 */
export function findCodeBlock(target: EventTarget | null, root: Element): Element | undefined {
  if (!(target instanceof Node)) {
    return undefined;
  }
  const element = target instanceof Element ? target : target.parentElement;
  const block = element?.closest('pre') ?? null;
  return block !== null && root.contains(block) && !isDiagramSource(block) ? block : undefined;
}

/**
 * Creates the code text: the text form of the whole code block, made by the same copy content creation as a copy.
 *
 * Line breaks and indentation stay, while the trailing line break that is not displayed and the text of comment entries
 * are left out, just as when the whole code block is selected and copied. Changes neither the tree nor the selection.
 *
 * @param block The code block.
 * @param root The editor root.
 * @param reportDiagnostic The diagnostic reporter for maintainers.
 * @returns The code text, or `undefined` if it could not be created. The creation then leaves one diagnostic line.
 */
export function readCodeBlockText(
  block: Element,
  root: Element,
  reportDiagnostic: DiagnosticReporter,
): string | undefined {
  const range = block.ownerDocument.createRange();
  range.selectNodeContents(block);
  return createCopyContent(range, root, reportDiagnostic)?.text;
}

/**
 * Decides where the button goes: the top right of the visible part of the code block.
 *
 * The part under the fixed toolbar's strip and the open search panel cannot be seen, so when the code block's top edge
 * is under them, the button moves down to just below them. It does not move past the code block: when the visible part
 * is shorter than the button, the button's bottom lines up with the code block's bottom.
 *
 * @param block The code block's rectangle.
 * @param size The button's size.
 * @param areaTop The top of the area the button can go in: the bottom of the toolbar's strip and of the open search
 *   panel, or 0 without either.
 * @returns The button's position.
 */
export function readCodeBlockCopyPlacement(
  block: CodeBlockCopyRect,
  size: CodeBlockCopySize,
  areaTop: number,
): CodeBlockCopyPosition {
  const lowest = block.bottom - size.height - CODE_BLOCK_COPY_INSET_PX;
  const top = Math.max(block.top + CODE_BLOCK_COPY_INSET_PX, Math.min(areaTop + CODE_BLOCK_COPY_INSET_PX, lowest));
  return { left: block.right - size.width - CODE_BLOCK_COPY_INSET_PX, top };
}

/**
 * Sends one code block copy request carrying the code text. Does not wait for a response.
 *
 * If the message cannot be sent, it ends with one diagnostic line and leaves the view as it is.
 *
 * @param channel The host channel.
 * @param text The code text.
 * @param reportDiagnostic Port that receives one diagnostic line for maintainers.
 */
export function requestCodeBlockCopy(channel: HostChannel, text: string, reportDiagnostic: DiagnosticReporter): void {
  try {
    channel.post({ type: VIEW_TO_HOST_MESSAGE_TYPE.codeBlockCopyRequested, text });
  } catch (error) {
    reportDiagnostic(`Could not send the code block copy request: ${String(error)}`);
  }
}

/**
 * Returns whether an event target lies inside an element, the element itself included.
 *
 * @param element The element.
 * @param target The event target, which may be missing or not a node.
 */
function contains(element: Element, target: EventTarget | null): boolean {
  return target instanceof Node && element.contains(target);
}
