import { INPUT_STOP_REASON } from './input-stop';
import type { InputStopController, InputStopReason } from './input-stop';

/**
 * The ID of the overlay element. Kept identical to the spelling in the stylesheet. There is always
 * exactly this one overlay element.
 */
export const OVERLAY_ELEMENT_ID = 'editor-overlay';

/** One overlay action placed on the overlay. */
export interface OverlayAction {
  /** The resolved message. */
  readonly label: string;
  /** The receiver called on every press. Pressing does not take the overlay down. */
  run(): void;
}

/** The content one overlay reason shows. When all three are empty, it is a blank overlay. */
export interface OverlayContent {
  /** The heading. Empty for a blank overlay. */
  readonly heading: string;
  /** The descriptions. */
  readonly descriptions: readonly string[];
  /** The overlay actions. */
  readonly actions: readonly OverlayAction[];
}

/**
 * The content of a blank overlay. The save round trip, the time before a restore settles and the
 * protection share it, so that they all look the same.
 */
export const BLANK_OVERLAY_CONTENT: OverlayContent = {
  heading: '',
  descriptions: [],
  actions: [],
};

/**
 * The order in which the sections are laid out. Each reason goes up and comes down on its own
 * trigger, so they are laid out in a fixed order rather than the order they went up in.
 *
 * The order is derived from `INPUT_STOP_REASON` rather than copied here. With a copy, a later
 * feature unit adding a reason would touch only `INPUT_STOP_REASON` and forget this list, and that
 * reason would then stop input while drawing no content, leaving the user unable to get out of an
 * overlay with neither text nor buttons. The action dialog is excluded because it shows itself in
 * its own element.
 */
const OVERLAY_REASON_ORDER: readonly InputStopReason[] = Object.values(INPUT_STOP_REASON)
  .filter((reason) => reason !== INPUT_STOP_REASON.actionDialog);

// The attributes put only on an overlay with content, and removed once it becomes blank.
const MODAL_ATTRIBUTES = ['aria-modal', 'tabindex', 'aria-labelledby', 'aria-describedby'] as const;

// The markers used to find the reference targets of the overlay's name and description.
const HEADING_CLASS = 'overlay-heading';
const DESCRIPTION_CLASS = 'overlay-description';

/** The ports the overlay presenter receives from outside. */
export interface OverlayPresenterPorts {
  /**
   * Notifies synchronously on every render, whether or not there is content.
   *
   * @param overlay The element of an overlay with content. `undefined` for a blank overlay and for
   *   removal.
   * @param wasFocusedInside Whether focus was inside the overlay before it was rebuilt. Rebuilding
   *   recreates the elements inside and focus is lost, so this is read before rebuilding and passed
   *   in.
   */
  notifyRendered(overlay: HTMLElement | undefined, wasFocusedInside: boolean): void;
}

/**
 * Presents, updates and removes the content received from a caller as an overlay with one common
 * appearance.
 *
 * Exactly one is created per view, and it is usable from before the mount. When to raise and lower
 * it, the messages and what the buttons do all belong to the caller.
 */
export class OverlayPresenter {
  private readonly contents = new Map<InputStopReason, OverlayContent>();

  /**
   * @param view The view's window.
   * @param inputStop The input stop controller. Editability and focus are moved only through it.
   * @param ports The port for render notifications. An overlay can go up even before the mount, so
   *   notifications are sent from startup.
   */
  constructor(
    private readonly view: Window,
    private readonly inputStop: InputStopController,
    private readonly ports: OverlayPresenterPorts,
  ) {}

  /**
   * Raises the overlay, or replaces the content of the same reason.
   *
   * The reason is added before presenting. The other order would leave a moment in which the
   * overlay is up while input is still accepted.
   *
   * @param reason The overlay's reason.
   * @param content The content to show.
   */
  present(reason: InputStopReason, content: OverlayContent): void {
    this.inputStop.add(reason);
    this.contents.set(reason, content);
    this.render();
  }

  /**
   * Lowers the overlay. A reason that is not up does nothing.
   *
   * @param reason The overlay's reason.
   * @returns Whether it was lowered; false when it was not up. This is how the caller learns that
   *   what it was waiting for was not there.
   */
  dismiss(reason: InputStopReason): boolean {
    if (!this.contents.delete(reason)) {
      return false;
    }

    // The overlay is removed before the reason. The other order would leave a moment in which input
    // is accepted while the overlay is still standing.
    this.render();
    this.inputStop.remove(reason);
    return true;
  }

  /**
   * Builds the overlay again from the reasons that remain. Once no reason asks for it, the element
   * itself is removed.
   */
  render(): void {
    const document = this.view.document;
    const existing = document.getElementById(OVERLAY_ELEMENT_ID);
    const active = document.activeElement;
    const wasFocusedInside = existing !== null && active !== null && existing.contains(active);
    if (this.contents.size === 0) {
      existing?.remove();
      this.ports.notifyRendered(undefined, wasFocusedInside);
      return;
    }

    const overlay = existing ?? document.createElement('div');
    if (existing === null) {
      overlay.id = OVERLAY_ELEMENT_ID;
      document.body.append(overlay);
    }

    // Everything is built again each time, so that no stale receiver is left behind.
    overlay.replaceChildren(
      ...OVERLAY_REASON_ORDER.flatMap((reason) => {
        const content = this.contents.get(reason);
        return content === undefined ? [] : buildSection(document, reason, content);
      }),
    );

    const blank = overlay.childElementCount === 0;

    // When no reason has any content, the background is left unpainted. Painting it would make the
    // document look as if it vanished for an instant on every save.
    overlay.toggleAttribute('data-blank', blank);

    // For the same reason it is given no role either, which would announce an alert dialog with
    // neither a name nor a body to assistive technology on every save.
    if (blank) {
      overlay.removeAttribute('role');
      for (const name of MODAL_ATTRIBUTES) {
        overlay.removeAttribute(name);
      }
      this.ports.notifyRendered(undefined, wasFocusedInside);
      return;
    }
    overlay.setAttribute('role', 'alertdialog');
    overlay.setAttribute('aria-modal', 'true');
    // Lets focus be moved to the overlay itself, without putting it into the Tab cycle.
    overlay.tabIndex = -1;
    // When reasons stack up, the headings and descriptions of all sections are associated in section
    // order.
    setReferences(overlay, 'aria-labelledby', `.${HEADING_CLASS}`);
    setReferences(overlay, 'aria-describedby', `.${DESCRIPTION_CLASS}`);
    this.ports.notifyRendered(overlay, wasFocusedInside);
  }
}

/**
 * Sets the attribute to the IDs of the reference targets inside the overlay, joined in document
 * order. Removes the attribute when there are no reference targets.
 *
 * @param overlay The overlay element.
 * @param name The name of the attribute to set.
 * @param selector The selector that finds the reference targets.
 */
function setReferences(overlay: HTMLElement, name: string, selector: string): void {
  const ids = [...overlay.querySelectorAll(selector)].map((element) => element.id);
  if (ids.length === 0) {
    overlay.removeAttribute(name);
    return;
  }
  overlay.setAttribute(name, ids.join(' '));
}

/**
 * Builds the section for one reason. A blank overlay creates no element.
 *
 * @param document The view's document.
 * @param reason The section's reason. Used to make the IDs of the name and description reference
 *   targets unique per reason.
 * @param content The content to show.
 */
function buildSection(document: Document, reason: InputStopReason, content: OverlayContent): HTMLElement[] {
  const children: HTMLElement[] = [];
  if (content.heading.length > 0) {
    const heading = document.createElement('p');
    heading.id = `${OVERLAY_ELEMENT_ID}-${reason}-heading`;
    heading.className = HEADING_CLASS;
    // Messages go in as text, so that the catalog's contents are never interpreted as HTML.
    heading.textContent = content.heading;
    children.push(heading);
  }

  content.descriptions.forEach((description, index) => {
    const paragraph = document.createElement('p');
    paragraph.id = `${OVERLAY_ELEMENT_ID}-${reason}-description-${index}`;
    paragraph.className = DESCRIPTION_CLASS;
    paragraph.textContent = description;
    children.push(paragraph);
  });

  for (const action of content.actions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = action.label;
    button.addEventListener('click', () => action.run());
    children.push(button);
  }

  if (children.length === 0) {
    return [];
  }

  const section = document.createElement('div');
  section.append(...children);
  return [section];
}
