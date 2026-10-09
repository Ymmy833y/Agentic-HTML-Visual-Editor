import { beforeEach, describe, expect, it } from 'vitest';

import { EDITOR_ROOT_ELEMENT_ID, createLocalizer } from '../../common/index';
import type { MessageKey } from '../../common/index';
import { ALERT_STATE } from '../../webview/editing/alert-state';
import { BLOCK_KIND } from '../../webview/editing/block-format';
import { NO_CARET_STATE } from '../../webview/editing/caret-state';
import type { CaretState } from '../../webview/editing/caret-state';
import { INLINE_FORMAT } from '../../webview/editing/inline-format';
import { LIST_KIND } from '../../webview/editing/list-structure';
import { ALERT_MESSAGE_KEY } from '../../webview/ui/alert-items';
import { BLOCK_KIND_MESSAGE_KEY, BlockTypeMenu } from '../../webview/ui/block-type-menu';
import { attachToolbar } from '../../webview/ui/toolbar';
import {
  PRESSED_FORMAT_SLOTS,
  PRESSED_LIST_SLOTS,
  readBlockTypeMarks,
  reflectToolbarState,
} from '../../webview/ui/toolbar-state';
import type { ToolbarStatePorts } from '../../webview/ui/toolbar-state';
import { ToolbarActivation } from '../../webview/ui/toolbar-activation';
import { TOOLBAR_SLOT } from '../../webview/ui/toolbar-slots';
import type { ToolbarSlot } from '../../webview/ui/toolbar-slots';
import { TooltipController } from '../../webview/ui/tooltip';

const localizer = createLocalizer({
  'toolbar.blockType': 'Test block type',
  'blockType.quote': 'Test quote',
  'blockType.paragraph': 'Test paragraph',
  'blockType.heading2': 'Test heading 2',
  'blockType.codeBlock': 'Test code block',
  'alert.note': 'Test note',
});

// Slots registered to receive reflection, with their message keys at registration. Link is not registered.
// It stays unregistered until the feature unit that registers it lands, and not sending to it is also under test.
const REGISTERED: readonly (readonly [ToolbarSlot, MessageKey])[] = [
  [TOOLBAR_SLOT.save, 'toolbar.save'],
  [TOOLBAR_SLOT.bold, 'toolbar.bold'],
  [TOOLBAR_SLOT.italic, 'toolbar.italic'],
  [TOOLBAR_SLOT.strikethrough, 'toolbar.strikethrough'],
  [TOOLBAR_SLOT.inlineCode, 'toolbar.inlineCode'],
  [TOOLBAR_SLOT.codeBlock, 'toolbar.codeBlock'],
  [TOOLBAR_SLOT.clearFormatting, 'toolbar.clearFormatting'],
  [TOOLBAR_SLOT.horizontalRule, 'toolbar.horizontalRule'],
  [TOOLBAR_SLOT.bulletList, 'toolbar.bulletList'],
  [TOOLBAR_SLOT.orderedList, 'toolbar.orderedList'],
];

interface Harness {
  readonly ports: ToolbarStatePorts;
  /** The `aria-pressed` of the slot's button, or `null` if the attribute is absent. */
  readonly readPressed: (slot: ToolbarSlot) => string | null;
  /** The item label of the slot's button, or `undefined` if the element is absent. */
  readonly readLabel: (slot: ToolbarSlot) => string | undefined;
}

/** Prepares the toolbar and the block type menu. */
function createHarness(): Harness {
  document.body.replaceChildren();
  const root = document.createElement('div');
  root.id = EDITOR_ROOT_ELEMENT_ID;
  document.body.append(root);

  const activation = new ToolbarActivation(window, {
    isInputStopped: () => false,
    isComposing: () => false,
    notifyPopupOpened: () => undefined,
    notifyPopupClosed: () => undefined,
    notifyBeforeRun: () => undefined,
  });
  const toolbar = attachToolbar(window, localizer, activation, new TooltipController(window));
  if (toolbar === undefined) {
    throw new Error('Could not attach the toolbar');
  }

  const blockTypeMenu = new BlockTypeMenu(localizer, activation, {
    readEditorRoot: () => root,
    isComposing: () => false,
    isInputStopped: () => false,
    runCommandEdit: () => false,
    ensureTargetBlock: () => undefined,
    reportDiagnostic: () => undefined,
  });

  for (const [slot, messageKey] of REGISTERED) {
    toolbar.register(slot, { kind: 'button', messageKey, iconPath: 'M0 0h1', run: () => undefined });
  }
  toolbar.register(TOOLBAR_SLOT.blockType, {
    kind: 'popup',
    messageKey: 'toolbar.blockType',
    iconPath: 'M0 0h1',
    buildPopup: (container) => blockTypeMenu.buildPopup(container),
  });

  return {
    ports: { toolbar, blockTypeMenu, localizer },
    readPressed: (slot) =>
      document.querySelector(`[data-slot="${slot}"] button`)?.getAttribute('aria-pressed') ?? null,
    readLabel: (slot) =>
      document.querySelector(`[data-slot="${slot}"] .toolbar-label`)?.textContent ?? undefined,
  };
}

/**
 * Builds a caret state. Fields not given take the no-target defaults.
 *
 * @param overrides Fields to override.
 * @returns The caret state.
 */
function createState(overrides: Partial<CaretState>): CaretState {
  return { ...NO_CARET_STATE, ...overrides };
}

describe('Reflecting onto the fixed toolbar', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('slots of formatted formats become pressed and slots of unformatted ones become not pressed', () => {
    const harness = createHarness();

    reflectToolbarState(
      harness.ports,
      createState({ formats: { ...NO_CARET_STATE.formats, bold: true } }),
    );

    expect([harness.readPressed(TOOLBAR_SLOT.bold), harness.readPressed(TOOLBAR_SLOT.italic)])
      .toEqual(['true', 'false']);
  });

  it('the code block slot becomes pressed when the kind is code block and it is convertible', () => {
    const harness = createHarness();

    reflectToolbarState(
      harness.ports,
      createState({ blockKind: BLOCK_KIND.codeBlock, convertible: true }),
    );

    expect(harness.readPressed(TOOLBAR_SLOT.codeBlock)).toBe('true');
  });

  it('when the kind is quote, the block type item label becomes the quote message', () => {
    const harness = createHarness();

    reflectToolbarState(
      harness.ports,
      createState({ blockKind: BLOCK_KIND.quote, convertible: true }),
    );

    expect(harness.readLabel(TOOLBAR_SLOT.blockType)).toBe('Test quote');
  });

  it('when the kind is quote with a known alert, the block type item label becomes the message of that alert kind', () => {
    const harness = createHarness();

    reflectToolbarState(
      harness.ports,
      createState({ blockKind: BLOCK_KIND.quote, convertible: true, alert: 'note' }),
    );

    expect(harness.readLabel(TOOLBAR_SLOT.blockType)).toBe('Test note');
  });

  it('when the kind is quote with an unknown alert, the block type item label stays the quote message', () => {
    const harness = createHarness();

    reflectToolbarState(
      harness.ports,
      createState({ blockKind: BLOCK_KIND.quote, convertible: true, alert: ALERT_STATE.unknown }),
    );

    expect(harness.readLabel(TOOLBAR_SLOT.blockType)).toBe('Test quote');
  });

  it('when the kind is paragraph inside a blockquote with a known alert, the block type item label becomes the message of that alert kind', () => {
    const harness = createHarness();

    reflectToolbarState(
      harness.ports,
      createState({ blockKind: BLOCK_KIND.paragraph, convertible: true, alert: 'note' }),
    );

    expect(harness.readLabel(TOOLBAR_SLOT.blockType)).toBe('Test note');
  });

  it('for a target block that is not convertible inside a blockquote with a known alert, the block type item label becomes the message of that alert kind', () => {
    const harness = createHarness();

    reflectToolbarState(
      harness.ports,
      createState({ blockKind: BLOCK_KIND.heading2, convertible: false, alert: 'note' }),
    );

    expect(harness.readLabel(TOOLBAR_SLOT.blockType)).toBe('Test note');
  });

  it('when the kind is div inside a blockquote with a known alert, the block type item label becomes the message of that alert kind', () => {
    const harness = createHarness();

    reflectToolbarState(
      harness.ports,
      createState({ blockKind: BLOCK_KIND.div, convertible: true, alert: 'note' }),
    );

    expect(harness.readLabel(TOOLBAR_SLOT.blockType)).toBe('Test note');
  });

  it('a heading inside a blockquote with a known alert keeps the heading message as the block type item label', () => {
    const harness = createHarness();

    reflectToolbarState(
      harness.ports,
      createState({ blockKind: BLOCK_KIND.heading2, convertible: true, alert: 'note' }),
    );

    expect(harness.readLabel(TOOLBAR_SLOT.blockType)).toBe('Test heading 2');
  });

  it('a code block inside a blockquote with a known alert keeps the code block message as the block type item label', () => {
    const harness = createHarness();

    reflectToolbarState(
      harness.ports,
      createState({ blockKind: BLOCK_KIND.codeBlock, convertible: true, alert: 'note' }),
    );

    expect(harness.readLabel(TOOLBAR_SLOT.blockType)).toBe('Test code block');
  });

  it('when the kind is paragraph inside a blockquote with an unknown alert, the block type item label stays the paragraph message', () => {
    const harness = createHarness();

    reflectToolbarState(
      harness.ports,
      createState({ blockKind: BLOCK_KIND.paragraph, convertible: true, alert: ALERT_STATE.unknown }),
    );

    expect(harness.readLabel(TOOLBAR_SLOT.blockType)).toBe('Test paragraph');
  });

  it('when there is no kind, the block type item label becomes the paragraph message instead of the registered message', () => {
    const harness = createHarness();
    reflectToolbarState(
      harness.ports,
      createState({ blockKind: BLOCK_KIND.quote, convertible: true }),
    );

    reflectToolbarState(harness.ports, NO_CARET_STATE);

    expect(harness.readLabel(TOOLBAR_SLOT.blockType)).toBe('Test paragraph');
  });

  it('when the kind is div, the block type item label becomes the paragraph message', () => {
    const harness = createHarness();

    reflectToolbarState(
      harness.ports,
      createState({ blockKind: BLOCK_KIND.div, convertible: true }),
    );

    expect(harness.readLabel(TOOLBAR_SLOT.blockType)).toBe('Test paragraph');
  });

  it('does not pass a pressed state to items without state', () => {
    const harness = createHarness();

    reflectToolbarState(
      harness.ports,
      createState({ formats: { ...NO_CARET_STATE.formats, bold: true } }),
    );

    expect([
      harness.readPressed(TOOLBAR_SLOT.save),
      harness.readPressed(TOOLBAR_SLOT.clearFormatting),
      harness.readPressed(TOOLBAR_SLOT.horizontalRule),
    ]).toEqual([null, null, null]);
  });

  it('when the list kind is bullet, only the bulleted list is pressed and the numbered list is not', () => {
    const harness = createHarness();

    reflectToolbarState(harness.ports, createState({ listKind: LIST_KIND.bullet }));

    expect([harness.readPressed(TOOLBAR_SLOT.bulletList), harness.readPressed(TOOLBAR_SLOT.orderedList)])
      .toEqual(['true', 'false']);
  });

  it('when the list kind is none, neither slot is pressed', () => {
    const harness = createHarness();
    reflectToolbarState(harness.ports, createState({ listKind: LIST_KIND.ordered }));

    reflectToolbarState(harness.ports, createState({ listKind: undefined }));

    expect([harness.readPressed(TOOLBAR_SLOT.bulletList), harness.readPressed(TOOLBAR_SLOT.orderedList)])
      .toEqual(['false', 'false']);
  });

  it('throws nothing when the link slot is unregistered, and reflection to other slots continues', () => {
    const harness = createHarness();

    reflectToolbarState(
      harness.ports,
      createState({ formats: { ...NO_CARET_STATE.formats, link: true, bold: true } }),
    );

    expect([harness.readPressed(TOOLBAR_SLOT.link), harness.readPressed(TOOLBAR_SLOT.bold)])
      .toEqual([null, 'true']);
  });
});

describe('Menu marks on popup items', () => {
  it('when the kind is paragraph, only the paragraph item key is in the set', () => {
    const marks = readBlockTypeMarks(
      createState({ blockKind: BLOCK_KIND.paragraph, convertible: true }),
    );

    expect([...marks]).toEqual([BLOCK_KIND_MESSAGE_KEY.paragraph]);
  });

  it('for a target block that is not convertible, no kind key is in the set but the key of a known alert is', () => {
    const marks = readBlockTypeMarks(
      createState({ blockKind: BLOCK_KIND.quote, convertible: false, alert: 'note' }),
    );

    expect([...marks]).toEqual([ALERT_MESSAGE_KEY.note]);
  });

  it('the set is empty for a target block that is not convertible and has no alert', () => {
    const marks = readBlockTypeMarks(
      createState({ blockKind: undefined, convertible: false, alert: ALERT_STATE.none }),
    );

    expect([...marks]).toEqual([]);
  });

  it('when the kind is paragraph inside a blockquote with a known alert, only the key of that alert kind is in the set, not the paragraph key', () => {
    const marks = readBlockTypeMarks(
      createState({ blockKind: BLOCK_KIND.paragraph, convertible: true, alert: 'tip' }),
    );

    expect([...marks]).toEqual([ALERT_MESSAGE_KEY.tip]);
  });

  it('when the kind is a heading inside a blockquote with a known alert, both the key of that alert kind and the heading key are in the set', () => {
    const marks = readBlockTypeMarks(
      createState({ blockKind: BLOCK_KIND.heading2, convertible: true, alert: 'tip' }),
    );

    expect([...marks]).toEqual([ALERT_MESSAGE_KEY.tip, BLOCK_KIND_MESSAGE_KEY.heading2]);
  });

  it('when the kind is quote and there is no alert, only the quote key is in the set', () => {
    const marks = readBlockTypeMarks(
      createState({ blockKind: BLOCK_KIND.quote, convertible: true, alert: ALERT_STATE.none }),
    );

    expect([...marks]).toEqual([BLOCK_KIND_MESSAGE_KEY.quote]);
  });

  it('when the kind is quote with a known alert, only the key of that alert kind is in the set, not the quote key', () => {
    const marks = readBlockTypeMarks(
      createState({ blockKind: BLOCK_KIND.quote, convertible: true, alert: 'note' }),
    );

    expect([...marks]).toEqual([ALERT_MESSAGE_KEY.note]);
  });

  it('when the alert is unknown, only the quote key is in the set', () => {
    const marks = readBlockTypeMarks(
      createState({ blockKind: BLOCK_KIND.quote, convertible: true, alert: ALERT_STATE.unknown }),
    );

    expect([...marks]).toEqual([BLOCK_KIND_MESSAGE_KEY.quote]);
  });

  it('the set is empty when the kind is code block', () => {
    const marks = readBlockTypeMarks(
      createState({ blockKind: BLOCK_KIND.codeBlock, convertible: true }),
    );

    expect([...marks]).toEqual([]);
  });

  it('the set is empty when the kind is div', () => {
    const marks = readBlockTypeMarks(
      createState({ blockKind: BLOCK_KIND.div, convertible: true }),
    );

    expect([...marks]).toEqual([]);
  });
});

describe('Table of slots whose pressed state comes from the list kind', () => {
  it('its slots are toolbar slot identifiers, and it covers each of the 2 kinds exactly once', () => {
    const slots: readonly string[] = Object.values(TOOLBAR_SLOT);

    expect([
      PRESSED_LIST_SLOTS.every(([slot]) => slots.includes(slot)),
      PRESSED_LIST_SLOTS.map(([, kind]) => kind).sort(),
    ]).toEqual([true, Object.values(LIST_KIND).sort()]);
  });
});

describe('Table mapping pressed state to formats', () => {
  it('every slot in the table is a toolbar slot identifier and every format is one of the 5 formats', () => {
    const slots: readonly string[] = Object.values(TOOLBAR_SLOT);
    const formats: readonly string[] = Object.values(INLINE_FORMAT);

    expect(
      PRESSED_FORMAT_SLOTS.filter(
        ([slot, format]) => !slots.includes(slot) || !formats.includes(format),
      ),
    ).toEqual([]);
  });
});
