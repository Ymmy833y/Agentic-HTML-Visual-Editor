import type { Localizer, MessageKey } from '../../common/index';
import { ALERT_STATE } from '../editing/alert-state';
import { runBlockOperation } from '../editing/block-command';
import type { BlockCommandPorts, BlockOperation } from '../editing/block-command';
import { BLOCK_KIND } from '../editing/block-format';
import type { BlockKind } from '../editing/block-format';
import type { ToolbarActivation } from './toolbar-activation';

/** The class of the element placed for the popup. The e2e layer also uses it to find the contents. */
export const BLOCK_TYPE_MENU_CLASS = 'block-type-menu';

/** Attribute name of the menu mark placed on the items matching the current kind and alert. The stylesheet uses the same spelling. */
export const BLOCK_TYPE_MENU_MARK_ATTRIBUTE = 'data-marked';

/**
 * The block kinds that have a message.
 *
 * Div has none: it is not listed in the block type menu, and the block type item shows it with the paragraph
 * message.
 */
export type LabeledBlockKind = Exclude<BlockKind, typeof BLOCK_KIND.div>;

/** The correspondence between the nine block kinds other than div and their message keys. */
export const BLOCK_KIND_MESSAGE_KEY: Readonly<Record<LabeledBlockKind, MessageKey>> = {
  paragraph: 'blockType.paragraph',
  heading1: 'blockType.heading1',
  heading2: 'blockType.heading2',
  heading3: 'blockType.heading3',
  heading4: 'blockType.heading4',
  heading5: 'blockType.heading5',
  heading6: 'blockType.heading6',
  quote: 'blockType.quote',
  codeBlock: 'blockType.codeBlock',
};

/** The block kinds that have an item in the block type menu. */
export type BlockTypeMenuKind = Exclude<LabeledBlockKind, typeof BLOCK_KIND.codeBlock>;

// The order in which the items are laid out in the popup. Code block and div are not listed: converting to a code
// block already has the code block button and ``` + Enter, so listing it too would put the same operation in two
// places, and converting to div is hardly ever needed.
const BLOCK_TYPE_MENU_ORDER: readonly BlockTypeMenuKind[] = [
  BLOCK_KIND.paragraph,
  BLOCK_KIND.heading1,
  BLOCK_KIND.heading2,
  BLOCK_KIND.heading3,
  BLOCK_KIND.heading4,
  BLOCK_KIND.heading5,
  BLOCK_KIND.heading6,
  BLOCK_KIND.quote,
];

// Looks up whether a kind has an item. Built from the order list so that the kinds are not spelled in two places.
const BLOCK_TYPE_MENU_KINDS: ReadonlySet<BlockKind> = new Set(BLOCK_TYPE_MENU_ORDER);

/**
 * Returns whether the kind has an item in the block type menu.
 *
 * @param kind The block kind.
 * @returns `true` when the menu has an item for it.
 */
export function isBlockTypeMenuKind(kind: BlockKind): kind is BlockTypeMenuKind {
  return BLOCK_TYPE_MENU_KINDS.has(kind);
}

/** One item of the popup. It holds no operation of its own, only the function to call when it is pressed. */
export interface BlockTypeMenuItem {
  /** The key of the message used for both the accessible name and the label. */
  readonly messageKey: MessageKey;
  /** The operation to call when the item is pressed. */
  run(): void;
}

/**
 * The contents of the block type menu.
 *
 * Exactly one is created per view. Following the boundary by which the owner of the contents opens the port for
 * additions, later feature units only add items here and take no part in the appearance or the ordering.
 */
export class BlockTypeMenu {
  private readonly added: BlockTypeMenuItem[] = [];

  // The received marks. Kept while closed and copied to the next popup that is built.
  private marks: ReadonlySet<MessageKey> = new Set();

  // Maps the message key of each built item to its button. Held as a list so that items sharing a
  // message key are not missed.
  private buttons: readonly { readonly messageKey: MessageKey; readonly button: HTMLButtonElement }[] = [];

  /**
   * @param localizer The localizer.
   * @param activation The toolbar activation.
   * @param ports The block command ports.
   */
  constructor(
    private readonly localizer: Localizer,
    private readonly activation: ToolbarActivation,
    private readonly ports: BlockCommandPorts,
  ) {}

  /**
   * Adds an item to the popup.
   *
   * @param item The item to add. It is laid out after this feature's own eight items.
   */
  addItem(item: BlockTypeMenuItem): void {
    this.added.push(item);
  }

  /**
   * Replaces the set of items that carry a menu mark.
   *
   * Does not decide which items to mark; copies the received set as-is. Accepts it while closed as
   * well, and while open replaces only the marks without closing. Closing while the user is choosing
   * again would leave them unable to choose.
   *
   * @param marks The set of message keys of the items to mark.
   */
  applyMarks(marks: ReadonlySet<MessageKey>): void {
    this.marks = marks;
    for (const entry of this.buttons) {
      const marked = marks.has(entry.messageKey);
      entry.button.toggleAttribute(BLOCK_TYPE_MENU_MARK_ATTRIBUTE, marked);
      // A mark that is only visual does not reach assistive technology, so it is reflected in the
      // checked state at the same time.
      entry.button.setAttribute('aria-checked', String(marked));
    }
  }

  /**
   * Builds the contents of the popup and places them.
   *
   * A press goes through the toolbar activation. Calling the operation directly would leave the input-stop and
   * composition checks off the items inside.
   *
   * @param container The container of the toolbar item.
   * @returns The popup element that was placed.
   */
  buildPopup(container: HTMLElement): HTMLElement {
    const document = container.ownerDocument;
    const popup = document.createElement('div');
    popup.className = BLOCK_TYPE_MENU_CLASS;
    popup.setAttribute('role', 'menu');

    // A mark can be on one kind item and one item added through the port for additions (an alert).
    // Without separate groups the menu would be read as having two checked items, so each group holds
    // its own checked state. The second group is not placed when no items have been added.
    const buttons: { readonly messageKey: MessageKey; readonly button: HTMLButtonElement }[] = [];
    for (const items of [this.readOwnItems(), this.added]) {
      if (items.length === 0) {
        continue;
      }
      const group = document.createElement('div');
      group.setAttribute('role', 'group');
      for (const item of items) {
        const label = this.localizer.getMessage(item.messageKey);
        const button = document.createElement('button');
        button.type = 'button';
        button.setAttribute('role', 'menuitemradio');
        // The label doubles as the accessible name. Items are never told apart by color or type size alone.
        button.setAttribute('aria-label', label);
        button.textContent = label;
        // Enter and Space from the keyboard also come through here, as the click raised by the
        // button's default press.
        button.addEventListener('click', () => {
          this.activation.activatePopupAction(() => item.run());
        });
        group.append(button);
        buttons.push({ messageKey: item.messageKey, button });
      }
      popup.append(group);
    }

    container.append(popup);
    this.buttons = buttons;
    // Copy the marks as of opening. Marks that arrived while closed become visible for the first time here.
    this.applyMarks(this.marks);
    return popup;
  }

  /**
   * Returns this feature's own eight items.
   *
   * @returns The items from paragraph through quote.
   */
  private readOwnItems(): BlockTypeMenuItem[] {
    return BLOCK_TYPE_MENU_ORDER.map((kind) => ({
      messageKey: BLOCK_KIND_MESSAGE_KEY[kind],
      run: () => {
        runBlockOperation(this.ports, readMenuOperation(kind), 'command');
      },
    }));
  }
}

/**
 * Returns the block operation a menu item calls.
 *
 * Quote is called as an alert operation with the selection none rather than as a conversion. A conversion leaves an
 * alert blockquote untouched as the same kind, and lets an alert attribute left on a paragraph take effect on the
 * blockquote, so the result would not look like the ordinary blockquote that was chosen.
 *
 * @param kind The kind of the item.
 * @returns The block operation the item calls.
 */
function readMenuOperation(kind: BlockTypeMenuKind): BlockOperation {
  if (kind === BLOCK_KIND.quote) {
    return { kind: 'alert', to: ALERT_STATE.none };
  }
  return { kind: 'convert', to: kind };
}
