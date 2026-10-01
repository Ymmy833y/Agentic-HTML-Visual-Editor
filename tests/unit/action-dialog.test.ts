import { beforeEach, describe, expect, it } from 'vitest';

import { EDITOR_ROOT_ELEMENT_ID, createLocalizer } from '../../common/index';
import {
  ACTION_DIALOG_BACKDROP_ELEMENT_ID,
  ACTION_DIALOG_CONFIRM_CLASS,
  ACTION_DIALOG_ELEMENT_ID,
  ActionDialogPresenter,
  buildRequirementLabels,
} from '../../webview/ui/action-dialog';
import type { ActionDialogSpec } from '../../webview/ui/action-dialog';
import { INPUT_STOP_REASON, InputStopController } from '../../webview/ui/input-stop';

const PENDING = 'not settled yet';

const SPEC: ActionDialogSpec = {
  title: 'Link',
  fields: [{ name: 'url', label: 'URL', initialValue: '' }],
  confirmLabel: 'OK',
  cancelLabel: 'Cancel',
};

/** The record of the open and close notifications sent by the action dialog presenter. */
interface DialogNotifications {
  /** The number of open requests. */
  opening: number;
  /** The elements that receive focus first, passed with the opened notifications. */
  readonly opened: HTMLElement[];
  /** Whether focus was inside before closing, passed with the closed notifications. */
  readonly closed: boolean[];
}

/** Creates an empty record of open and close notifications. */
function createNotifications(): DialogNotifications {
  return { opening: 0, opened: [], closed: [] };
}

/** Ports to replace. Without them, the ports behave as in the real environment. */
interface PortOverrides {
  /** The lookup of registered shortcuts. By default no key matches. */
  readonly hasShortcut?: (event: KeyboardEvent) => boolean;
  /** The input stop controller. Pass it to add a reason from outside the dialog. */
  readonly inputStop?: InputStopController;
}

/**
 * Builds the action dialog presenter.
 *
 * @param hideFloatingMenu The port that closes the floating menu. Pass it to count its calls.
 * @param notifications The record the open and close notifications are written to. Pass it to count
 *   the notifications.
 * @param overrides The ports to replace.
 */
function createPresenter(
  hideFloatingMenu: () => void = () => undefined,
  notifications: DialogNotifications = createNotifications(),
  overrides: PortOverrides = {},
): ActionDialogPresenter {
  document.body.replaceChildren();
  const root = document.createElement('div');
  root.id = EDITOR_ROOT_ELEMENT_ID;
  root.contentEditable = 'true';
  document.body.append(root);

  return new ActionDialogPresenter(window, {
    inputStop: overrides.inputStop ?? new InputStopController({
      readEditorRoot: () => root,
      hasViewFocus: () => true,
      deferReturn: () => undefined,
      notifyResumed: () => undefined,
    }),
    hasShortcut: overrides.hasShortcut ?? (() => false),
    closePopup: () => undefined,
    hideTooltip: () => undefined,
    hideFloatingMenu,
    notifyOpening: () => {
      notifications.opening += 1;
    },
    notifyOpened: (_dialog, first) => {
      notifications.opened.push(first);
    },
    notifyClosed: (wasFocusedInside) => {
      notifications.closed.push(wasFocusedInside);
    },
  });
}

/** Confirms that the result has not settled yet by racing it against an already resolved value. */
async function settleOrPending(result: Promise<unknown>): Promise<unknown> {
  return Promise.race([result, Promise.resolve(PENDING)]);
}

describe('presenting the action dialog', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('presents no second dialog while one is open and returns a cancellation for it', async () => {
    const presenter = createPresenter();
    void presenter.open(SPEC);

    const second = await presenter.open({ ...SPEC, title: 'Image' });

    expect([second, document.querySelectorAll(`#${ACTION_DIALOG_ELEMENT_ID}`).length]).toEqual([
      { confirmed: false },
      1,
    ]);
  });

  it('renders the confirmation text and places no input field when there are no input fields', () => {
    const presenter = createPresenter();
    void presenter.open({ ...SPEC, title: 'Discard', fields: [], confirmation: 'Discard your edits?' });

    const dialog = document.getElementById(ACTION_DIALOG_ELEMENT_ID);
    expect([
      [...(dialog?.querySelectorAll('p') ?? [])].map((paragraph) => paragraph.textContent),
      dialog?.querySelectorAll('input').length,
    ]).toEqual([['Discard', 'Discard your edits?', ''], 0]);
  });

  it('stays open and shows exactly one rejection reason when the validation rejects', async () => {
    const presenter = createPresenter();
    const result = presenter.open({ ...SPEC, validate: () => 'URL is required' });

    presenter.confirm();
    presenter.confirm();

    const dialog = document.getElementById(ACTION_DIALOG_ELEMENT_ID);
    expect([
      dialog?.querySelectorAll('[role="alert"]').length,
      dialog?.querySelector('[role="alert"]')?.textContent,
    ]).toEqual([1, 'URL is required']);
    await expect(settleOrPending(result)).resolves.toBe(PENDING);
  });

  it('closes and returns the confirmation with the values when the validation passes', async () => {
    const presenter = createPresenter();
    const result = presenter.open(SPEC);
    const input = document.querySelector<HTMLInputElement>(`#${ACTION_DIALOG_ELEMENT_ID} input`);
    if (input === null) {
      throw new Error('The input field was not built');
    }
    input.value = 'https://example.test/';

    presenter.confirm();

    await expect(result).resolves.toEqual({ confirmed: true, values: { url: 'https://example.test/' } });
    expect(document.getElementById(ACTION_DIALOG_ELEMENT_ID)).toBeNull();
  });

  it('returns a cancellation and discards the values being typed when the tree is replaced', async () => {
    const presenter = createPresenter();
    const result = presenter.open(SPEC);

    presenter.handleDocumentReplaced();

    await expect(result).resolves.toEqual({ confirmed: false });
    expect(document.getElementById(ACTION_DIALOG_ELEMENT_ID)).toBeNull();
  });
});

describe('the backdrop of the action dialog', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it.each([
    ['confirm', (presenter: ActionDialogPresenter) => presenter.confirm()],
    ['cancel', (presenter: ActionDialogPresenter) => presenter.cancel()],
    ['replacement of the tree', (presenter: ActionDialogPresenter) => presenter.handleDocumentReplaced()],
  ])('places one backdrop right before the dialog on opening and removes it on closing by %s', (_way, close) => {
    const presenter = createPresenter();
    void presenter.open(SPEC);
    const opened = [
      document.querySelectorAll(`#${ACTION_DIALOG_BACKDROP_ELEMENT_ID}`).length,
      document.getElementById(ACTION_DIALOG_ELEMENT_ID)?.previousElementSibling?.id,
    ];

    close(presenter);

    expect([opened, document.getElementById(ACTION_DIALOG_BACKDROP_ELEMENT_ID)])
      .toEqual([[1, ACTION_DIALOG_BACKDROP_ELEMENT_ID], null]);
  });

  it('returns a cancellation without validating and removes the dialog when the backdrop is clicked', async () => {
    let validated = 0;
    const presenter = createPresenter();
    const result = presenter.open({
      ...SPEC,
      validate: () => {
        validated += 1;
        return 'URL is required';
      },
    });

    document.getElementById(ACTION_DIALOG_BACKDROP_ELEMENT_ID)?.click();

    expect([await result, validated, document.getElementById(ACTION_DIALOG_ELEMENT_ID)])
      .toEqual([{ confirmed: false }, 0, null]);
  });
});

describe('Closing the floating menu', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('opening a dialog calls the close port once', () => {
    let closed = 0;
    const presenter = createPresenter(() => {
      closed += 1;
    });

    void presenter.open(SPEC);

    expect(closed).toBe(1);
  });

  it('does not call the close port when another dialog is open and cancel is returned', async () => {
    let closed = 0;
    const presenter = createPresenter(() => {
      closed += 1;
    });
    void presenter.open(SPEC);

    await presenter.open({ ...SPEC, title: 'Image' });

    expect(closed).toBe(1);
  });
});

describe('open and close notifications of the action dialog', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('passes the confirm button with the opened notification for a confirmation without input fields, and the presenter itself does not move focus', () => {
    const notifications = createNotifications();
    const presenter = createPresenter(() => undefined, notifications);
    const outside = document.createElement('button');
    document.body.append(outside);
    outside.focus();

    void presenter.open({ ...SPEC, title: 'Discard', fields: [], confirmation: 'Discard your edits?' });

    const confirmButton = document.querySelector(`#${ACTION_DIALOG_ELEMENT_ID} .${ACTION_DIALOG_CONFIRM_CLASS}`);
    expect([
      notifications.opened.length === 1 && notifications.opened[0] === confirmButton,
      confirmButton?.textContent,
      document.activeElement === outside,
    ]).toEqual([true, 'OK', true]);
  });

  it('sends none of the opening, opened or closed notifications for a call made while another dialog is open', async () => {
    const notifications = createNotifications();
    const presenter = createPresenter(() => undefined, notifications);
    void presenter.open(SPEC);

    await presenter.open({ ...SPEC, title: 'Image' });

    // Only the opening and opened notifications of the first dialog remain.
    expect([notifications.opening, notifications.opened.length, notifications.closed.length])
      .toEqual([1, 1, 0]);
  });
});

/** Reads the button labels of the open dialog, in their row order. */
function readButtonLabels(): (string | null)[] {
  return [...document.querySelectorAll(`#${ACTION_DIALOG_ELEMENT_ID} button`)]
    .map((button) => button.textContent);
}

/**
 * Returns the extra action button of the open dialog, which comes first in the button row.
 *
 * @returns The extra action button.
 */
function readExtraButton(): HTMLButtonElement {
  const button = document.querySelectorAll<HTMLButtonElement>(`#${ACTION_DIALOG_ELEMENT_ID} button`)[0];
  if (button === undefined) {
    throw new Error('No extra action button');
  }
  return button;
}

/**
 * Dispatches keys to the input field of the open dialog and returns the key values that reached the window.
 *
 * @param events The key presses to dispatch.
 * @returns The key values that reached the window's bubbling phase, in the order dispatched.
 */
function dispatchToField(events: readonly KeyboardEvent[]): string[] {
  const input = document.querySelector(`#${ACTION_DIALOG_ELEMENT_ID} input`);
  if (input === null) {
    throw new Error('No input field');
  }
  const reached: string[] = [];
  const record = (event: KeyboardEvent): void => {
    reached.push(event.key);
  };
  window.addEventListener('keydown', record);
  for (const event of events) {
    input.dispatchEvent(event);
  }
  window.removeEventListener('keydown', record);
  return reached;
}

describe('the extra action of the action dialog', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('lays out the buttons as the extra action, cancel and confirm when an extra action is given, and as cancel and confirm alone otherwise', () => {
    const presenter = createPresenter();
    void presenter.open({ ...SPEC, extraActionLabel: 'Remove' });
    const withExtra = readButtonLabels();
    presenter.cancel();

    void presenter.open(SPEC);

    expect([withExtra, readButtonLabels()]).toEqual([['Remove', 'Cancel', 'OK'], ['Cancel', 'OK']]);
  });

  it('closes without calling the validation and returns the extra action result when the extra action button is pressed', async () => {
    let validated = 0;
    const presenter = createPresenter();
    const result = presenter.open({
      ...SPEC,
      extraActionLabel: 'Remove',
      validate: () => {
        validated += 1;
        return 'URL is required';
      },
    });

    readExtraButton().click();

    expect([await result, validated, document.getElementById(ACTION_DIALOG_ELEMENT_ID)])
      .toEqual([{ confirmed: false, extraAction: true }, 0, null]);
  });

  it('keeps the dialog open and returns no result when the extra action button is pressed while an overlay reason remains', async () => {
    // An input stop controller without an editor root. The check looks only at the set of reasons, so editability
    // and focus are not moved.
    const inputStop = new InputStopController({
      readEditorRoot: () => undefined,
      hasViewFocus: () => true,
      deferReturn: () => undefined,
      notifyResumed: () => undefined,
    });
    const presenter = createPresenter(undefined, undefined, { inputStop });
    const result = presenter.open({ ...SPEC, extraActionLabel: 'Remove' });
    inputStop.add(INPUT_STOP_REASON.saveRoundTrip);

    readExtraButton().click();

    expect([document.getElementById(ACTION_DIALOG_ELEMENT_ID) !== null, await settleOrPending(result)])
      .toEqual([true, PENDING]);
  });
});

describe('registered shortcut keys while the dialog is shown', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('keeps a key aimed at the input field that matches the lookup from reaching the window, without preventing its default action', () => {
    const presenter = createPresenter(undefined, undefined, {
      hasShortcut: (event) => event.key === 'k' && event.ctrlKey,
    });
    void presenter.open(SPEC);
    const event = new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true });

    const reached = dispatchToField([event]);

    expect([reached, event.defaultPrevented]).toEqual([[], false]);
  });

  it('lets a key that does not match the lookup, and Tab even when it matches, reach the window as before', () => {
    const presenter = createPresenter(undefined, undefined, {
      hasShortcut: (event) => event.key === 'Tab' || (event.key === 'k' && event.ctrlKey),
    });
    void presenter.open(SPEC);

    const reached = dispatchToField([
      new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }),
      new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
    ]);

    expect(reached).toEqual(['s', 'Tab']);
  });
});

describe('the requirement badge of the action dialog', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  const LABELS = { required: 'Required', optional: 'Optional' };

  /** Reads the requirement attributes and the label's own text of each field of the open dialog. */
  function readFieldMarks(): unknown[] {
    return [...document.querySelectorAll<HTMLLabelElement>(`#${ACTION_DIALOG_ELEMENT_ID} label`)].map((label) => [
      label.dataset.requirement,
      label.dataset.requirementLabel,
      label.querySelector('input')?.getAttribute('aria-required'),
      label.textContent,
    ]);
  }

  it('marks a required field and an optional field differently and leaves a field that says neither unmarked', () => {
    const presenter = createPresenter();
    void presenter.open({
      ...SPEC,
      fields: [
        { name: 'source', label: 'Path', initialValue: '', required: true },
        { name: 'alt', label: 'Alt', initialValue: '', required: false },
        { name: 'note', label: 'Note', initialValue: '' },
      ],
      requirementLabels: LABELS,
    });

    expect(readFieldMarks()).toEqual([
      ['required', 'Required', 'true', 'Path'],
      ['optional', 'Optional', null, 'Alt'],
      [undefined, undefined, null, 'Note'],
    ]);
  });

  it('keeps the badge text out of the label text, so that the field name stays the label alone', () => {
    const presenter = createPresenter();
    void presenter.open({
      ...SPEC,
      fields: [{ name: 'url', label: 'URL', initialValue: '', required: true }],
      requirementLabels: LABELS,
    });

    const label = document.querySelector(`#${ACTION_DIALOG_ELEMENT_ID} label`);
    expect([label?.textContent, label?.querySelectorAll('span').length]).toEqual(['URL', 0]);
  });

  it('shows no badge without the requirement labels, but still marks a required field for assistive technology', () => {
    const presenter = createPresenter();
    void presenter.open({ ...SPEC, fields: [{ name: 'url', label: 'URL', initialValue: '', required: true }] });

    expect(readFieldMarks()).toEqual([[undefined, undefined, 'true', 'URL']]);
  });

  it('resolves the badge texts from the localizer', () => {
    expect(buildRequirementLabels(createLocalizer({
      'actionDialog.required': 'Needed',
      'actionDialog.optional': 'Skippable',
    }))).toEqual({ required: 'Needed', optional: 'Skippable' });
  });
});

describe('a multi-line field of the action dialog', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  /**
   * Presses Enter inside a field.
   *
   * @param field The field.
   * @param modifiers The modifier keys held with Enter.
   * @returns Whether the default was stopped.
   */
  function pressEnter(field: Element, modifiers: KeyboardEventInit = {}): boolean {
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...modifiers });
    field.dispatchEvent(event);
    return event.defaultPrevented;
  }

  it('is built as a text area, where Enter breaks the line without confirming and the primary modifier+Enter confirms', async () => {
    const presenter = createPresenter();
    const result = presenter.open({
      ...SPEC,
      fields: [{ name: 'source', label: 'Source', initialValue: 'graph TD', multiline: true }],
    });
    const field = document.querySelector(`#${ACTION_DIALOG_ELEMENT_ID} textarea`);
    if (!(field instanceof HTMLTextAreaElement)) {
      throw new Error('no text area');
    }

    const plainPrevented = pressEnter(field);
    const afterPlain = await settleOrPending(result);
    const controlPrevented = pressEnter(field, { ctrlKey: true });

    expect([field.value, plainPrevented, afterPlain, controlPrevented, await result]).toEqual([
      'graph TD',
      false,
      PENDING,
      true,
      { confirmed: true, values: { source: 'graph TD' } },
    ]);
  });
});
