// Helpers for unit tests that need to mount HTML into a DOM root and place a
// Selection / Range over a target node.

export function makeRoot(html: string = ''): HTMLElement {
  const root = document.createElement('div');
  root.id = 'ahve-root';
  root.innerHTML = html;
  document.body.replaceChildren(root);
  return root;
}

export function clearDom(): void {
  document.body.replaceChildren();
}

/** Place a collapsed caret at the start of the given element. */
export function caretAtStart(el: Node): void {
  const sel = window.getSelection();
  if (!sel) throw new Error('no selection');
  const range = document.createRange();
  range.setStart(el, 0);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

/** Place a collapsed caret at the end of the given element. */
export function caretAtEnd(el: Node): void {
  const sel = window.getSelection();
  if (!sel) throw new Error('no selection');
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

/** Select the entire contents of the given element. */
export function selectContents(el: Node): void {
  const sel = window.getSelection();
  if (!sel) throw new Error('no selection');
  const range = document.createRange();
  range.selectNodeContents(el);
  sel.removeAllRanges();
  sel.addRange(range);
}

/** Select a substring inside a text node (by character offsets). */
export function selectTextRange(textNode: Node, start: number, end: number): void {
  const sel = window.getSelection();
  if (!sel) throw new Error('no selection');
  const range = document.createRange();
  range.setStart(textNode, start);
  range.setEnd(textNode, end);
  sel.removeAllRanges();
  sel.addRange(range);
}
