import type { Localizer } from '../../common/index';
import { INPUT_STOP_REASON } from './input-stop';
import type { InputStopController } from './input-stop';
import { OVERLAY_ELEMENT_ID } from './overlay-presenter';

/** The ID of the dialog element. Kept identical to the spelling in the stylesheet. */
export const ACTION_DIALOG_ELEMENT_ID = 'action-dialog';

/**
 * The ID of the backdrop element placed behind the dialog. Kept identical to the spelling in the
 * stylesheet. The backdrop counts as part of the dialog: pressing it cancels the dialog.
 */
export const ACTION_DIALOG_BACKDROP_ELEMENT_ID = `${ACTION_DIALOG_ELEMENT_ID}-backdrop`;

/**
 * The class of the confirm button. Kept identical to the spelling in the stylesheet, which gives it
 * the primary button colors.
 */
export const ACTION_DIALOG_CONFIRM_CLASS = `${ACTION_DIALOG_ELEMENT_ID}-confirm`;

// The IDs of the title and confirmation text elements. Only one dialog is open at a time, so fixed
// spellings are unique.
const TITLE_ELEMENT_ID = `${ACTION_DIALOG_ELEMENT_ID}-title`;
const CONFIRMATION_ELEMENT_ID = `${ACTION_DIALOG_ELEMENT_ID}-confirmation`;

// The classes of the button row and the extra action button. Kept identical to the spellings in the
// stylesheet, which lays the row out and pushes the extra action to its start.
const ACTIONS_CLASS = `${ACTION_DIALOG_ELEMENT_ID}-actions`;
const EXTRA_ACTION_CLASS = `${ACTION_DIALOG_ELEMENT_ID}-extra`;

// The keys the dialog handles itself while shown. They are not looked up even if a registered shortcut has the same
// key (Shift+Tab also has the key value Tab).
const HANDLED_KEYS: ReadonlySet<string> = new Set(['Enter', 'Escape', 'Tab']);

/**
 * One input field. Single-line text unless it asks for several lines.
 */
export interface ActionDialogField {
  /** The name the value is looked up by in the result. */
  readonly name: string;
  /** The resolved label. */
  readonly label: string;
  /** The initial value. */
  readonly initialValue: string;
  /**
   * Whether the field takes several lines. Shift+Enter inside such a field breaks the line, and Enter confirms as in
   * any other field.
   */
  readonly multiline?: boolean;
  /**
   * Whether the field needs a value. `true` marks the field as required for assistive technology, and either value
   * shows a badge saying so next to the label when the spec gives the requirement labels. Left out for a field that
   * says neither.
   */
  readonly required?: boolean;
}

/** The resolved texts of the badge that tells whether a field is required. */
export interface ActionDialogRequirementLabels {
  /** The badge of a required field. */
  readonly required: string;
  /** The badge of an optional field. */
  readonly optional: string;
}

/**
 * Resolves the badge texts of the requirement labels.
 *
 * @param localizer The localizer.
 * @returns The requirement labels for the spec.
 */
export function buildRequirementLabels(localizer: Localizer): ActionDialogRequirementLabels {
  return {
    required: localizer.getMessage('actionDialog.required'),
    optional: localizer.getMessage('actionDialog.optional'),
  };
}

/** The dialog's spec. Messages are taken already resolved. */
export interface ActionDialogSpec {
  /** The title. */
  readonly title: string;
  /** The input fields. Left empty for a confirmation. */
  readonly fields: readonly ActionDialogField[];
  /**
   * The badge texts of the fields that say whether they are required. Without it no badge is shown, even for a field
   * that gives `required`.
   */
  readonly requirementLabels?: ActionDialogRequirementLabels;
  /** The confirmation text, used by a dialog that has no input fields. */
  readonly confirmation?: string;
  /** The confirm label. */
  readonly confirmLabel: string;
  /** The cancel label. */
  readonly cancelLabel: string;
  /**
   * The extra action label. When given, its button is placed at the start of the button row, before
   * cancel and confirm; when omitted, only cancel and confirm are shown.
   *
   * With only confirm and cancel, an operation that does not use the input values, such as removing a link,
   * could not be chosen from the same dialog, so exactly one can be added.
   */
  readonly extraActionLabel?: string;
  /**
   * The validation run on confirm.
   *
   * @param values The input field names mapped to their values.
   * @returns The rejection reason, or `undefined` when the values pass.
   */
  validate?(values: Readonly<Record<string, string>>): string | undefined;
}

/**
 * The dialog's result. It is returned exactly once per request.
 *
 * The extra action is not a confirm, so `confirmed` is false, and it carries the mark `extraAction` that tells it
 * apart from cancel. A caller that passes no extra action only needs to look at `confirmed`, as before.
 */
export type ActionDialogResult =
  | { readonly confirmed: true; readonly values: Readonly<Record<string, string>> }
  | { readonly confirmed: false; readonly extraAction: true }
  | { readonly confirmed: false };

/** The ports the action dialog presenter takes from outside. */
export interface ActionDialogPorts {
  /** The input stop controller. Editability and focus are moved only through it. */
  readonly inputStop: InputStopController;

  /**
   * Returns only whether the pressed key matches a shortcut registered with the shortcut receiver. Runs no
   * action and changes neither propagation nor the default action.
   *
   * @param event The pressed key.
   */
  hasShortcut(event: KeyboardEvent): boolean;

  /** Closes the open popup. */
  closePopup(): void;

  /** Hides the tooltip currently shown. */
  hideTooltip(): void;

  /** Closes the floating menu if it is shown. */
  hideFloatingMenu(): void;

  /**
   * When no other dialog is open, notifies synchronously of the open request before focus moves. The
   * receiver does not let exceptions escape.
   */
  notifyOpening(): void;

  /**
   * Notifies synchronously that the dialog has opened, after it is built. Whether to move focus is
   * up to the receiver. The receiver does not let exceptions escape.
   *
   * @param dialog The dialog element.
   * @param first The element that receives focus first: the first input field, or the confirm button
   *   when there are no input fields.
   */
  notifyOpened(dialog: HTMLElement, first: HTMLElement): void;

  /**
   * Notifies synchronously that the dialog has closed, after the reason is removed and before the
   * result is returned. The receiver does not let exceptions escape.
   *
   * @param wasFocusedInside Whether focus was inside the dialog before its element was removed.
   */
  notifyClosed(wasFocusedInside: boolean): void;
}

/** One open request, together with the function that returns its result. */
interface OpenRequest {
  readonly element: HTMLElement;
  readonly backdrop: HTMLElement;
  readonly inputs: readonly FieldElement[];
  readonly rejection: HTMLElement;
  readonly validate: ActionDialogSpec['validate'];
  readonly settle: (result: ActionDialogResult) => void;
}

/**
 * Presents the spec received from a caller with one common appearance, and returns the result
 * exactly once: Enter confirms, Esc and a press on the backdrop cancel. However, Enter while a button has focus presses that
 * button, and Esc while focus is inside the overlay does not cancel.
 *
 * Exactly one is created per view, and only one dialog is open at a time. It is presented in its
 * own element and does not go through the overlay presenter.
 */
export class ActionDialogPresenter {
  private request: OpenRequest | undefined;

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (this.request === undefined || event.isComposing) {
      // Enter and Esc during a composition commit and cancel the composition. Picking them up here
      // would close the dialog in the middle of a conversion.
      return;
    }
    if (event.key === 'Enter') {
      if (event.target instanceof HTMLTextAreaElement && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
        // Left to the field, which breaks the line. Enter confirms from a multi-line field as well, the same way the
        // comment fields commit, so that every field in the view takes the same keys.
        return;
      }
      if (event.target instanceof HTMLButtonElement) {
        // Left to the press of the focused button. Treating it as a confirmation would confirm even
        // when the cancel button was chosen. The same holds for an overlay action: the dialog is not
        // confirmed while the overlay is being dealt with.
        return;
      }
      event.preventDefault();
      this.confirm();
      return;
    }
    if (event.key === 'Escape') {
      const overlay = this.view.document.getElementById(OVERLAY_ELEMENT_ID);
      if (overlay !== null && event.target instanceof Node && overlay.contains(event.target)) {
        // Closing the dialog on Esc while the overlay is being dealt with would lose the input.
        return;
      }
      event.preventDefault();
      this.cancel();
    }
  };

  // Keys aimed inside the dialog that match a registered shortcut are kept from reaching VS Code. If primary
  // modifier+K or the like reached it, VS Code would wait for the rest of a two-stroke key binding, and the next
  // stroke could run an operation such as closing the editor. Preventing the default action as well would take
  // caret movement and paste away from the input field, so only propagation is stopped.
  private readonly onDialogKeyDown = (event: KeyboardEvent): void => {
    if (event.isComposing || HANDLED_KEYS.has(event.key)) {
      // Strokes during a composition belong to the IME. Enter and Esc are used for confirm and cancel, and Tab
      // for trapping focus, so they are handled as before even if a registered shortcut has the same key.
      return;
    }
    if (this.ports.hasShortcut(event)) {
      event.stopPropagation();
    }
  };

  /**
   * @param view The view's window.
   * @param ports The ports for the input stop controller, the popup and the tooltip.
   */
  constructor(
    private readonly view: Window,
    private readonly ports: ActionDialogPorts,
  ) {}

  /**
   * Opens the dialog and waits for input.
   *
   * @param spec The dialog's spec.
   * @returns The confirmation together with the values, or a cancellation. When another action
   *   dialog is already open, nothing is opened and a cancellation is returned.
   */
  open(spec: ActionDialogSpec): Promise<ActionDialogResult> {
    if (this.request !== undefined) {
      return Promise.resolve({ confirmed: false });
    }

    // Closing the popup removes the items inside and focus is lost, so the receiver is notified
    // before closing, letting it read the return target.
    this.ports.notifyOpening();
    this.ports.closePopup();
    this.ports.hideTooltip();
    // Keep a single interactive surface. For the same reason as the popup, it is closed only on opening.
    this.ports.hideFloatingMenu();
    // The reason is added before presenting. The other order would leave a moment in which the
    // dialog is up while the editor root still accepts input.
    this.ports.inputStop.add(INPUT_STOP_REASON.actionDialog);

    const built = this.build(spec);
    this.view.document.addEventListener('keydown', this.onKeyDown, true);

    return new Promise<ActionDialogResult>((resolve) => {
      this.request = {
        element: built.element,
        backdrop: built.backdrop,
        inputs: built.inputs,
        rejection: built.rejection,
        validate: spec.validate,
        settle: resolve,
      };
      // Focus goes to the first input field. In a confirmation there is nothing to press but the
      // confirm button.
      // The element is decided here, and whether to move focus is left to the receiver, because
      // focus is not moved while an overlay with content is on top or while the view does not have
      // focus.
      this.ports.notifyOpened(built.element, built.inputs[0] ?? built.confirmButton);
    });
  }

  /**
   * Accepts the confirmation.
   *
   * It is not accepted while an overlay reason remains. Letting it through would have the caller
   * rewrite the tree in the middle of a save round trip.
   */
  confirm(): void {
    const request = this.request;
    if (request === undefined || this.ports.inputStop.hasOtherReason(INPUT_STOP_REASON.actionDialog)) {
      return;
    }

    const values = readValues(request.inputs);
    const rejection = request.validate?.(values);
    if (rejection !== undefined) {
      // The dialog stays open and shows exactly one rejection reason. Stacking them up would make
      // it unclear what needs fixing.
      request.rejection.textContent = rejection;
      return;
    }

    this.close(request);
    request.settle({ confirmed: true, values });
  }

  /**
   * Closes with the extra action.
   *
   * The operation does not use the input values, so it skips validation. Like confirm, it is not accepted while
   * an overlay reason remains; accepting it would let the caller rewrite the tree in the middle of a save round
   * trip. Like confirm, the result is returned after the reason is removed and the selection is returned.
   */
  runExtraAction(): void {
    const request = this.request;
    if (request === undefined || this.ports.inputStop.hasOtherReason(INPUT_STOP_REASON.actionDialog)) {
      return;
    }

    this.close(request);
    request.settle({ confirmed: false, extraAction: true });
  }

  /**
   * Closes as a cancellation. Nothing is validated, and the result is returned even while an
   * overlay reason remains.
   */
  cancel(): void {
    const request = this.request;
    if (request === undefined) {
      return;
    }

    this.close(request);
    request.settle({ confirmed: false });
  }

  /**
   * Closes as a cancellation, if a dialog is up, on learning that the tree has been replaced.
   *
   * The captured selection is lost in the replacement, so confirming would put the result at a
   * position unrelated to the original selection.
   */
  handleDocumentReplaced(): void {
    this.cancel();
  }

  /**
   * Builds the elements from the spec and places them.
   *
   * @param spec The dialog's spec.
   */
  private build(spec: ActionDialogSpec): {
    readonly element: HTMLElement;
    readonly backdrop: HTMLElement;
    readonly inputs: readonly FieldElement[];
    readonly rejection: HTMLElement;
    readonly confirmButton: HTMLButtonElement;
  } {
    const document = this.view.document;
    // The backdrop dims everything behind the dialog while it is open, and a press on it cancels
    // the dialog. The mouse press is not given its default action, so that focus stays in the
    // dialog until the cancellation returns it to where it was. The dialog closes on the click
    // rather than on the press, so that the release does not land on what lies behind.
    const backdrop = document.createElement('div');
    backdrop.id = ACTION_DIALOG_BACKDROP_ELEMENT_ID;
    backdrop.addEventListener('mousedown', (event) => event.preventDefault());
    backdrop.addEventListener('click', () => this.cancel());

    const element = document.createElement('div');
    element.id = ACTION_DIALOG_ELEMENT_ID;
    element.setAttribute('role', 'dialog');
    element.setAttribute('aria-modal', 'true');
    // Has assistive technology read the title as the name and the confirmation text as the
    // description when the dialog opens.
    element.setAttribute('aria-labelledby', TITLE_ELEMENT_ID);

    const title = document.createElement('p');
    title.id = TITLE_ELEMENT_ID;
    // Messages go in as text, so that the catalog's contents are never interpreted as HTML.
    title.textContent = spec.title;
    element.append(title);

    if (spec.confirmation !== undefined) {
      const confirmation = document.createElement('p');
      confirmation.id = CONFIRMATION_ELEMENT_ID;
      confirmation.textContent = spec.confirmation;
      element.append(confirmation);
      element.setAttribute('aria-describedby', CONFIRMATION_ELEMENT_ID);
    }

    const inputs = spec.fields.map((field) => {
      const label = document.createElement('label');
      label.textContent = field.label;
      const input = createFieldElement(document, field.multiline === true);
      input.name = field.name;
      input.value = field.initialValue;
      if (field.required === true) {
        input.setAttribute('aria-required', 'true');
      }
      if (field.required !== undefined && spec.requirementLabels !== undefined) {
        // The badge is drawn by the stylesheet from these attributes, next to the label's text and outside the label's
        // text content, so that the field's name stays the label alone. The state is spoken through aria-required.
        label.dataset.requirement = field.required ? 'required' : 'optional';
        label.dataset.requirementLabel = field.required ? spec.requirementLabels.required : spec.requirementLabels.optional;
      }
      label.append(input);
      element.append(label);
      return input;
    });

    const rejection = document.createElement('p');
    rejection.setAttribute('role', 'alert');
    element.append(rejection);

    // The buttons sit in one row in the order extra action, cancel, confirm. Tab follows the same
    // order, so it reaches confirm last.
    const actions = document.createElement('div');
    actions.className = ACTIONS_CLASS;
    if (spec.extraActionLabel !== undefined) {
      const extraButton = document.createElement('button');
      extraButton.type = 'button';
      extraButton.className = EXTRA_ACTION_CLASS;
      extraButton.textContent = spec.extraActionLabel;
      extraButton.addEventListener('click', () => this.runExtraAction());
      actions.append(extraButton);
    }

    const cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.textContent = spec.cancelLabel;
    cancelButton.addEventListener('click', () => this.cancel());

    const confirmButton = document.createElement('button');
    confirmButton.type = 'button';
    confirmButton.className = ACTION_DIALOG_CONFIRM_CLASS;
    confirmButton.textContent = spec.confirmLabel;
    confirmButton.addEventListener('click', () => this.confirm());

    actions.append(cancelButton, confirmButton);
    element.append(actions);
    // Listened for in the element's bubbling phase, so that only keys aimed inside the dialog are seen. The
    // element is rebuilt on every open, so there is no need to remove the listener on close.
    element.addEventListener('keydown', this.onDialogKeyDown);
    // The backdrop goes right before the dialog, so that it stays behind the dialog in the document
    // order as well.
    document.body.append(backdrop, element);
    return { element, backdrop, inputs, rejection, confirmButton };
  }

  /**
   * Removes the dialog together with its backdrop and removes the reason.
   *
   * @param request The open request.
   */
  private close(request: OpenRequest): void {
    // Removing the element takes focus away from the elements inside, so this is read before
    // removing it.
    const active = this.view.document.activeElement;
    const wasFocusedInside = active !== null && request.element.contains(active);
    this.request = undefined;
    request.backdrop.remove();
    request.element.remove();
    this.view.document.removeEventListener('keydown', this.onKeyDown, true);
    this.ports.inputStop.remove(INPUT_STOP_REASON.actionDialog);
    this.ports.notifyClosed(wasFocusedInside);
  }
}

/** The element of one input field. */
type FieldElement = HTMLInputElement | HTMLTextAreaElement;

/**
 * Creates the element of one input field.
 *
 * @param document The view's document.
 * @param multiline Whether the field takes several lines.
 * @returns A multi-line text area, or a single-line text input.
 */
function createFieldElement(document: Document, multiline: boolean): FieldElement {
  if (multiline) {
    const area = document.createElement('textarea');
    // Source text is written as is. Spell checking and automatic capitalization would only get in the way.
    area.spellcheck = false;
    area.setAttribute('autocapitalize', 'off');
    return area;
  }
  const input = document.createElement('input');
  input.type = 'text';
  return input;
}

/**
 * Builds the map from input field names to their values.
 *
 * @param inputs The input fields.
 */
function readValues(inputs: readonly FieldElement[]): Readonly<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const input of inputs) {
    values[input.name] = input.value;
  }
  return values;
}
