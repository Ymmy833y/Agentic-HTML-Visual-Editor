/**
 * Identifiers for the toolbar slots.
 *
 * These are never transmitted, but the feature units that register items name their slot by this
 * spelling, so a spelling is never changed once it has been decided.
 */
export const TOOLBAR_SLOT = {
  sidebar: 'sidebar',
  save: 'save',
  blockType: 'blockType',
  bold: 'bold',
  italic: 'italic',
  strikethrough: 'strikethrough',
  inlineCode: 'inlineCode',
  codeBlock: 'codeBlock',
  clearFormatting: 'clearFormatting',
  link: 'link',
  image: 'image',
  bulletList: 'bulletList',
  orderedList: 'orderedList',
  horizontalRule: 'horizontalRule',
  details: 'details',
  table: 'table',
  diagram: 'diagram',
  comment: 'comment',
  copy: 'copy',
  // A place where only the E2E probe items register; production feature units never register here. Even after every
  // slot is filled with production items, this lets the behavior of buttons and popups whose content is not a list
  // be verified independently of production items.
  probe: 'probe',
} as const;

/** A toolbar slot. A value outside the table above cannot be registered. */
export type ToolbarSlot = (typeof TOOLBAR_SLOT)[keyof typeof TOOLBAR_SLOT];

/**
 * The slot order, divided into groups by separators.
 *
 * The order never depends on the order of registration. If the layout moved with the implementation
 * or initialization order of the registering feature units, the buttons would change position every
 * time a feature unit is added. Lists need two buttons, bulleted and ordered, so two slots sit at
 * that position. A feature unit that needs a new slot makes the change that adds it to this order.
 */
export const TOOLBAR_SLOT_GROUPS: readonly (readonly ToolbarSlot[])[] = [
  // The sidebar opens at the left edge of the view, so its button sits at the left end, right next to it when open.
  [TOOLBAR_SLOT.sidebar],
  [TOOLBAR_SLOT.save],
  [TOOLBAR_SLOT.blockType],
  [
    TOOLBAR_SLOT.bold,
    TOOLBAR_SLOT.italic,
    TOOLBAR_SLOT.strikethrough,
    TOOLBAR_SLOT.inlineCode,
    TOOLBAR_SLOT.codeBlock,
  ],
  [TOOLBAR_SLOT.clearFormatting],
  [TOOLBAR_SLOT.link],
  [TOOLBAR_SLOT.image],
  [TOOLBAR_SLOT.bulletList, TOOLBAR_SLOT.orderedList],
  [TOOLBAR_SLOT.horizontalRule],
  [TOOLBAR_SLOT.details],
  [TOOLBAR_SLOT.table],
  [TOOLBAR_SLOT.diagram],
  [TOOLBAR_SLOT.comment],
  [TOOLBAR_SLOT.copy],
  // The probe slot goes last so that End reaches it. Nothing is placed there in production, so no extra separator
  // appears either.
  [TOOLBAR_SLOT.probe],
];
