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
  const alert = readKnownAlert(state);
  if (alert !== undefined) {
    // The alert of the blockquote around the caret is marked whatever the block holding the caret is, because an
    // alert item acts on that blockquote. The alert items are a group of their own, so this mark sits beside the
    // mark of the kind.
    marks.add(ALERT_MESSAGE_KEY[alert]);
  }

  const kind = readReflectedKind(state);
  // Where the item label shows the alert, only the alert is marked, so that the marks agree with the label the same
  // way inside an alert blockquote as on one holding only text. The quote item there also clears the alert, so
  // marking it would make it look like an item that changes nothing when pressed. An unknown value looks like an
  // ordinary blockquote and the quote item leaves it alone, so quote is marked in that case. Code block and div have
  // no item in the menu, so no item is marked for them.
  if (kind !== undefined && isBlockTypeMenuKind(kind) && !(alert !== undefined && isShownByAlert(kind))) {
    marks.add(BLOCK_KIND_MESSAGE_KEY[kind]);
  }
  return marks;
}

/**
 * Returns the message key of the item label shown on the block type item.
 *
 * Anything other than a heading, a quote or a code block (a paragraph, a div, or no kind) gets the paragraph
 * message. Div, which is not in the menu, and list items and details titles, which have no kind, are shown as
 * paragraphs, so that the registered message, which is not a kind, never appears as the item label. Inside a
 * blockquote with a known alert, what would read as a paragraph or a quote is shown by the alert kind instead.
 *
 * @param kind The kind to reflect, or `undefined` when there is no kind.
 * @param alert The known alert kind of the alert target, or `undefined` when there is none.
 * @returns The message key.
 */
function readBlockTypeLabelKey(kind: BlockKind | undefined, alert: AlertKind | undefined): MessageKey {
  if (alert !== undefined && isShownByAlert(kind)) {
    return ALERT_MESSAGE_KEY[alert];
  }
  if (kind === undefined || kind === BLOCK_KIND.div) {
    return BLOCK_KIND_MESSAGE_KEY.paragraph;
  }
  return BLOCK_KIND_MESSAGE_KEY[kind];
}

/**
 * Determines whether a block of a kind is shown by the known alert of its alert target.
 *
 * Otherwise a paragraph or a quote would read the same in every alert blockquote, and the label would not tell the
 * alert kinds apart. A heading and a code block keep their own kind, which tells more about the block than the alert
 * does.
 *
 * @param kind The kind to reflect, or `undefined` when there is no kind.
 * @returns `true` for a paragraph, a div, a quote and no kind.
 */
function isShownByAlert(kind: BlockKind | undefined): boolean {
  return kind === undefined
    || kind === BLOCK_KIND.paragraph
    || kind === BLOCK_KIND.div
    || kind === BLOCK_KIND.quote;
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
