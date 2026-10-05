import type { AlertKind, Localizer, MessageKey } from '../../common/index';
import { ALERT_STATE } from '../editing/alert-state';
import { BLOCK_KIND } from '../editing/block-format';
import type { BlockKind } from '../editing/block-format';
import type { CaretState } from '../editing/caret-state';
import { INLINE_FORMAT } from '../editing/inline-format';
import type { InlineFormat } from '../editing/inline-format';
import { LIST_KIND } from '../editing/list-structure';
import type { ListKind } from '../editing/list-structure';
import { ALERT_MESSAGE_KEY } from './alert-items';
import { BLOCK_KIND_MESSAGE_KEY, isBlockTypeMenuKind } from './block-type-menu';
import type { BlockTypeMenu } from './block-type-menu';
import { TOOLBAR_SLOT } from './toolbar-slots';
import type { ToolbarSlot } from './toolbar-slots';
import type { Toolbar, ToolbarItemState } from './toolbar';

/**
 * Slots whose pressed state is taken from a format, paired with that format.
 */
export const PRESSED_FORMAT_SLOTS: readonly (readonly [ToolbarSlot, InlineFormat])[] = [
  [TOOLBAR_SLOT.bold, INLINE_FORMAT.bold],
  [TOOLBAR_SLOT.italic, INLINE_FORMAT.italic],
  [TOOLBAR_SLOT.strikethrough, INLINE_FORMAT.strikethrough],
  [TOOLBAR_SLOT.inlineCode, INLINE_FORMAT.inlineCode],
  [TOOLBAR_SLOT.link, INLINE_FORMAT.link],
];

/**
 * Slots whose pressed state is taken from the list kind, paired with that kind.
 *
 * Kept apart from the format table: that table's element type is limited to inline formats, and the floating
 * menu reads it too.
 */
export const PRESSED_LIST_SLOTS: readonly (readonly [ToolbarSlot, ListKind])[] = [
  [TOOLBAR_SLOT.bulletList, LIST_KIND.bullet],
  [TOOLBAR_SLOT.orderedList, LIST_KIND.ordered],
];

/** Ports for reflection. */
export interface ToolbarStatePorts {
  /** The fixed toolbar. */
  readonly toolbar: Toolbar;
  /** The block type menu. It can receive menu marks even when not open. */
  readonly blockTypeMenu: BlockTypeMenu;
  /** Message resolution. */
  readonly localizer: Localizer;
}

/**
 * Copies the caret state onto the fixed toolbar. Changes neither the tree nor the selection.
 *
 * @param ports Ports for reflection.
 * @param state The caret state.
 */
export function reflectToolbarState(ports: ToolbarStatePorts, state: CaretState): void {
  for (const [slot, format] of PRESSED_FORMAT_SLOTS) {
    updateRegistered(ports.toolbar, slot, { pressed: state.formats[format] });
  }

  // Only the slot matching the kind is pressed; the other slot, and both slots for "none", are sent as not pressed.
  for (const [slot, kind] of PRESSED_LIST_SLOTS) {
    updateRegistered(ports.toolbar, slot, { pressed: state.listKind === kind });
  }

  const kind = readReflectedKind(state);

  // Align with where the code block toggle leads. On a target that cannot be converted, pressing it
  // does nothing, so it is not shown as pressed either.
  updateRegistered(ports.toolbar, TOOLBAR_SLOT.codeBlock, {
    pressed: kind === BLOCK_KIND.codeBlock,
  });

  updateRegistered(ports.toolbar, TOOLBAR_SLOT.blockType, {
    label: ports.localizer.getMessage(readBlockTypeLabelKey(kind, readKnownAlert(state))),
  });

  ports.blockTypeMenu.applyMarks(readBlockTypeMarks(state));
}

/**
 * Collects the message keys of the popup items to mark.
 *
 * @param state The caret state.
 * @returns The set of message keys of the items to mark.
 */
export function readBlockTypeMarks(state: CaretState): ReadonlySet<MessageKey> {
  const marks = new Set<MessageKey>();
  const kind = readReflectedKind(state);
  if (kind === undefined) {
    return marks;
  }

  const alert = readKnownAlert(state);
  if (alert !== undefined) {
    // In an alert blockquote the quote item gets no menu mark. The quote item clears the alert, so marking it would
    // make it look like an item that changes nothing when pressed. An unknown value looks like an ordinary
    // blockquote and the quote item leaves it alone, so quote is marked below in that case.
    marks.add(ALERT_MESSAGE_KEY[alert]);
    return marks;
  }
  // Code block and div have no item in the menu, so no item is marked for them.
  if (isBlockTypeMenuKind(kind)) {
    marks.add(BLOCK_KIND_MESSAGE_KEY[kind]);
  }
  return marks;
}

/**
 * Returns the message key of the item label shown on the block type item.
 *
 * Anything other than a heading, a quote or a code block (a paragraph, a div, or no kind) gets the paragraph
 * message. Div, which is not in the menu, and list items and details titles, which have no kind, are shown as
 * paragraphs, so that the registered message, which is not a kind, never appears as the item label. A quote with a
 * known alert is shown by its alert kind, because every alert blockquote would otherwise read as the same quote.
 *
 * @param kind The kind to reflect, or `undefined` when there is no kind.
 * @param alert The known alert kind, or `undefined` when there is none.
 * @returns The message key.
 */
function readBlockTypeLabelKey(kind: BlockKind | undefined, alert: AlertKind | undefined): MessageKey {
  if (kind === undefined || kind === BLOCK_KIND.div) {
    return BLOCK_KIND_MESSAGE_KEY.paragraph;
  }
  if (kind === BLOCK_KIND.quote && alert !== undefined) {
    return ALERT_MESSAGE_KEY[alert];
  }
  return BLOCK_KIND_MESSAGE_KEY[kind];
}

/**
 * Returns the alert kind when the caret state holds a known one.
 *
 * @param state The caret state.
 * @returns The alert kind. `undefined` for an unknown value and when there is no alert.
 */
function readKnownAlert(state: CaretState): AlertKind | undefined {
  return state.alert === ALERT_STATE.unknown || state.alert === ALERT_STATE.none ? undefined : state.alert;
}

/**
 * Returns the kind used to reflect the block type.
 *
 * @param state The caret state.
 * @returns The kind to reflect. `undefined` when there is no kind.
 */
function readReflectedKind(state: CaretState): BlockKind | undefined {
  return state.convertible ? state.blockKind : undefined;
}

/**
 * Sends the toolbar item state only to registered slots.
 *
 * @param toolbar The fixed toolbar.
 * @param slot The slot.
 * @param state The toolbar item state to send.
 */
function updateRegistered(
  toolbar: Toolbar,
  slot: ToolbarSlot,
  state: ToolbarItemState,
): void {
  if (toolbar.readItem(slot) === undefined) {
    return;
  }
  toolbar.updateItemState(slot, state);
}
