import type { DiagramImage } from '../diagram/diagram-render';
import { CELL_RANGE_MARK_NAME, CELL_RANGE_MARK_NAMESPACE } from '../editing/cell-range';
import { CHANGE_OPEN_MARK_NAME, CHANGE_OPEN_MARK_NAMESPACE } from '../ui/change-popup';
import { COMMENT_CARET_MARK_NAME, COMMENT_CARET_MARK_NAMESPACE } from '../ui/comment-caret';
import { COMMENT_OPEN_MARK_NAME, COMMENT_OPEN_MARK_NAMESPACE } from '../ui/comment-popup';
import { PDF_STYLESHEET_TEXT } from './pdf-stylesheet';

/**
 * Width of the area inside the margins of an A4 page, in CSS pixels: 180 mm at 96 pixels per inch.
 *
 * The document is laid out again at this width, as a browser does when printing, so the PDF looks the same whatever
 * the width of the window.
 */
export const PDF_CONTENT_WIDTH_PX = 680;

// The element and class names html2canvas-pro gives the stand-ins for ::before and ::after. It hides the pseudo
// elements themselves with a style element, which the content security policy of the view blocks, so the same rules
// are given again with the stylesheet of the copy.
const PSEUDO_ELEMENT_NAME = 'html2canvaspseudoelement';

const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
const PSEUDO_BEFORE_CLASS = '___html2canvas___pseudoelement_before';
const PSEUDO_AFTER_CLASS = '___html2canvas___pseudoelement_after';
const PSEUDO_HIDE_RULES = `.${PSEUDO_BEFORE_CLASS}::before, .${PSEUDO_AFTER_CLASS}::after `
  + '{ content: "" !important; display: none !important; }';

// The properties of a stand-in that carry colors. html2canvas-pro copies them from the view before the theme is taken
// out of the copy, so they are read again from the copy.
const COLOR_PROPERTIES = [
  'color',
  'background-color',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'outline-color',
  'text-decoration-color',
  '-webkit-text-fill-color',
];

// The look of a comment's annotated text: background, border and underline, for every author and for resolved
// comments. A PDF is read apart from the review, so the annotated text is drawn as plain text, like the rest of the
// document.
const PLAIN_COMMENT_RULES = '#editor-root comment '
  + '{ background: none !important; outline: none !important; text-decoration: none !important; }';

// Marks that follow the selection, the caret or an open popup. They show the state of the editing, not the document.
const TRANSIENT_MARKS: readonly (readonly [namespace: string, name: string])[] = [
  [CELL_RANGE_MARK_NAMESPACE, CELL_RANGE_MARK_NAME],
  [CHANGE_OPEN_MARK_NAMESPACE, CHANGE_OPEN_MARK_NAME],
  [COMMENT_CARET_MARK_NAMESPACE, COMMENT_CARET_MARK_NAME],
  [COMMENT_OPEN_MARK_NAMESPACE, COMMENT_OPEN_MARK_NAME],
];

/** What the copy needs beyond the copied tree. */
export interface PdfCloneOptions {
  /**
   * The diagrams drawn with the light theme, keyed by the position of their source block among the `pre` elements of
   * the editor root.
   */
  readonly diagramImages: ReadonlyMap<number, DiagramImage>;
}

/**
 * Turns the tree of the copy that html2canvas-pro made into the document as it is printed.
 *
 * Only the editor root is kept, laid out from the left edge at the width of the page. The stylesheets the copy brought
 * along are removed; {@link stylePdfClone} gives the document's rules instead. The colors of the VS Code theme are
 * taken out, so every color falls back to the light values the stylesheet gives when there is no theme.
 * The diagrams are replaced by their light drawings, the bodies of closed collapsible sections are removed, and the
 * marks of the editing are dropped. Nodes of the copy keep the
 * classes of the view's window, so they are told apart by their names rather than by their classes.
 *
 * @param document The copied document.
 * @param root The copy of the editor root.
 * @param options The diagrams drawn with the light theme.
 */
export function preparePdfClone(document: Document, root: HTMLElement, options: PdfCloneOptions): void {
  for (const element of document.querySelectorAll('link[rel~="stylesheet"], style')) {
    element.remove();
  }

  removeTheme(document);
  const body = document.body;
  body.replaceChildren(root);
  body.style.setProperty('margin', '0', 'important');
  body.style.setProperty('padding', '0', 'important');
  root.style.setProperty('padding', '0', 'important');
  root.style.setProperty('margin', '0', 'important');

  replaceDiagrams(document, root, options.diagramImages);
  removeClosedBodies(root);
  removeTransientMarks(root);
}

/**
 * Gives the copy the document's rules, without the look of the comments, and the colors of the copy to the stand-ins
 * of the pseudo elements.
 *
 * The rules go in as constructed stylesheets, which the content security policy allows, where a style element would be
 * blocked. Called after {@link preparePdfClone}, so the stand-ins read the colors without the theme.
 *
 * @param document The copied document.
 * @param root The copy of the editor root.
 * @throws When the copy cannot be given its stylesheet; drawing without it would give an unstyled PDF.
 */
export function stylePdfClone(document: Document, root: HTMLElement): void {
  adoptStylesheet(document, `${PDF_STYLESHEET_TEXT}\n${PLAIN_COMMENT_RULES}`);
  recolorPseudoElements(document, root);
  adoptStylesheet(document, PSEUDO_HIDE_RULES);
}

/**
 * Adds rules to the copy as a constructed stylesheet.
 *
 * @param document The copied document.
 * @param rules The rules.
 * @throws When the window of the copy cannot construct stylesheets.
 */
function adoptStylesheet(document: Document, rules: string): void {
  const SheetConstructor = document.defaultView?.CSSStyleSheet;
  if (SheetConstructor === undefined) {
    throw new Error('The copy has no window to construct its stylesheet in');
  }
  const sheet = new SheetConstructor();
  sheet.replaceSync(rules);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
}

/**
 * Takes the VS Code theme out of the copy: the theme variables on the root element and the theme classes and
 * attributes on the body.
 *
 * @param document The copied document.
 */
function removeTheme(document: Document): void {
  const style = document.documentElement.style;
  const names: string[] = [];
  for (let index = 0; index < style.length; index += 1) {
    const name = style.item(index);
    if (name.startsWith('--vscode-')) {
      names.push(name);
    }
  }
  for (const name of names) {
    style.removeProperty(name);
  }
  // The stylesheet declares both schemes so that controls follow a dark theme; a light page wants light controls.
  style.setProperty('color-scheme', 'light', 'important');

  const body = document.body;
  for (const name of [...body.classList]) {
    if (name.startsWith('vscode-')) {
      body.classList.remove(name);
    }
  }
  for (const attribute of [...body.attributes]) {
    if (attribute.name.startsWith('data-vscode-')) {
      body.removeAttributeNode(attribute);
    }
  }
}

/**
 * Replaces each diagram source block with an image of its light drawing.
 *
 * The view paints a diagram as a pseudo element whose rule lives in a constructed stylesheet, which does not reach the
 * copy, and whose colors follow the theme. A block without a light drawing is kept, so it shows what the view shows
 * for a diagram that cannot be drawn.
 *
 * @param document The copied document.
 * @param root The copy of the editor root.
 * @param images The light drawings keyed by the position of their block among the `pre` elements.
 */
function replaceDiagrams(document: Document, root: HTMLElement, images: ReadonlyMap<number, DiagramImage>): void {
  const blocks = [...root.querySelectorAll('pre')];
  const view = document.defaultView;
  for (const [index, image] of images) {
    const block = blocks[index];
    if (block === undefined) {
      continue;
    }
    const picture = document.createElement('img');
    picture.src = image.url;
    picture.alt = '';
    picture.style.display = 'block';
    picture.style.width = `${String(image.width)}px`;
    picture.style.maxWidth = '100%';
    picture.style.height = 'auto';
    // The copy is measured before the image has loaded, so the proportions give it its height from the start.
    picture.style.aspectRatio = `${String(image.width)} / ${String(image.height)}`;
    if (view !== null) {
      picture.style.margin = view.getComputedStyle(block).margin;
    }
    block.replaceWith(picture);
  }
}

/**
 * Removes everything but the summary from each closed collapsible section, as the view shows it.
 *
 * The drawing decides visibility element by element, and would draw the hidden body of a closed section over the blocks
 * after it.
 *
 * @param root The copy of the editor root.
 */
function removeClosedBodies(root: HTMLElement): void {
  for (const section of root.querySelectorAll('details:not([open])')) {
    const summary = [...section.children].find((child) => child.localName === 'summary');
    section.replaceChildren(...(summary === undefined ? [] : [summary]));
  }
}

/**
 * Removes the marks of the selection, the caret and the open popups.
 *
 * @param root The copy of the editor root.
 */
function removeTransientMarks(root: HTMLElement): void {
  for (const element of [root, ...root.querySelectorAll('*')]) {
    for (const [namespace, name] of TRANSIENT_MARKS) {
      element.removeAttributeNS(namespace, name);
    }
  }
}

/**
 * Gives the stand-ins of the pseudo elements the colors of the copy.
 *
 * @param document The copied document.
 * @param root The copy of the editor root.
 */
function recolorPseudoElements(document: Document, root: HTMLElement): void {
  const view = document.defaultView;
  if (view === null) {
    return;
  }
  for (const standIn of root.getElementsByTagName(PSEUDO_ELEMENT_NAME)) {
    const owner = standIn.parentElement;
    if (owner === null || !isHtmlElement(standIn)) {
      continue;
    }
    // The stand-in for ::before is inserted first and the one for ::after last.
    const pseudo = owner.firstChild === standIn && owner.classList.contains(PSEUDO_BEFORE_CLASS) ? '::before' : '::after';
    const computed = view.getComputedStyle(owner, pseudo);
    for (const name of COLOR_PROPERTIES) {
      const value = computed.getPropertyValue(name);
      if (value !== '') {
        standIn.style.setProperty(name, value);
      }
    }
  }
}

/**
 * Tells whether an element is an HTML element, by its namespace.
 *
 * The copy is built from nodes of the view and then moved into the frame of the copy, so its nodes keep the classes of
 * the view's window and fail `instanceof` against the frame's.
 *
 * @param element The element.
 */
function isHtmlElement(element: Element): element is HTMLElement {
  return element.namespaceURI === XHTML_NAMESPACE;
}
