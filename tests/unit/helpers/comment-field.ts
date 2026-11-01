import type { CommentField, CommentFieldPorts } from '../../../webview/ui/comment-field';

/**
 * Builds the ports of a comment field. A dialog is canceled, and content goes in as it is.
 *
 * @param overrides Ports to override.
 * @returns The ports.
 */
export function createFieldPorts(overrides: Partial<CommentFieldPorts> = {}): CommentFieldPorts {
  return {
    openDialog: () => Promise.resolve({ confirmed: false }),
    prepareContent: () => undefined,
    notifyStateChanged: () => undefined,
    reportDiagnostic: () => undefined,
    ...overrides,
  };
}

/**
 * Returns the editable area of a field.
 *
 * @param field The field.
 * @returns The element that takes focus and input.
 */
export function readFieldTextbox(field: CommentField): HTMLElement {
  const textbox = field.element.querySelector('[role="textbox"]');
  if (!(textbox instanceof HTMLElement)) {
    throw new Error('the field has no editable text');
  }
  return textbox;
}

/**
 * Simulates typing: replaces what the field holds and sends the input event the browser sends after it.
 *
 * @param field The field.
 * @param html What the editable area holds afterward: its blocks.
 */
export function typeIntoField(field: CommentField, html: string): void {
  const textbox = readFieldTextbox(field);
  textbox.innerHTML = html;
  textbox.dispatchEvent(new Event('input'));
}

/**
 * Returns what a field holds, as an entry would be written with it, as HTML.
 *
 * @param field The field.
 * @returns The HTML of the content. The empty string for an empty field.
 */
export function readFieldHtml(field: CommentField): string {
  return readContentHtml(field.readContent());
}

/**
 * Builds entry content from HTML.
 *
 * @param html The HTML.
 * @returns A fragment of the document holding the parsed nodes.
 */
export function createContent(html: string): DocumentFragment {
  const container = document.createElement('div');
  container.innerHTML = html;
  const content = document.createDocumentFragment();
  content.append(...container.childNodes);
  return content;
}

/**
 * Returns entry content as HTML. The fragment stays as it is.
 *
 * @param content The content.
 * @returns The HTML.
 */
export function readContentHtml(content: DocumentFragment): string {
  const container = document.createElement('div');
  container.append(content.cloneNode(true));
  return container.innerHTML;
}
