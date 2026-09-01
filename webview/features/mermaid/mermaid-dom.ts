import { findBlockAncestor, isBlockEmptyOrStubBr, unwrap } from '../../shared/dom-utils';

export const MERMAID_MOUNTED_ATTR = 'data-ahve-mermaid-mounted';
export const MERMAID_KIND_ATTR = 'data-ahve-mermaid-kind';
export const MERMAID_SOURCE_ATTR = 'data-ahve-mermaid-source';
export const MERMAID_PREVIEW_ATTR = 'data-ahve-mermaid-preview';
export const MERMAID_STATE_ATTR = 'data-ahve-mermaid-state';
export const MERMAID_EDITABLE_ATTR = 'data-ahve-mermaid-original-contenteditable';

const MISSING_ATTRIBUTE = '__ahve_missing__';

export const DEFAULT_MERMAID_SOURCE = 'graph TD\n  A --> B';

type MermaidKind = 'pre' | 'code';

export interface MermaidSourceBlock {
  pre: HTMLPreElement;
  source: HTMLElement;
  preview: HTMLElement;
  kind: MermaidKind;
}

/** Insert the public Mermaid representation at the current editor selection. */
export function insertMermaidAtSelection(
  root: HTMLElement,
  source = DEFAULT_MERMAID_SOURCE,
): MermaidSourceBlock | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const liveRange = selection.getRangeAt(0);
  if (
    !root.contains(liveRange.startContainer) ||
    !root.contains(liveRange.endContainer)
  ) {
    return null;
  }

  const range = liveRange.cloneRange();
  range.collapse(true);
  const pre = document.createElement('pre');
  pre.className = 'mermaid';
  pre.textContent = source;

  const block = findBlockAncestor(range.startContainer, root);
  if (block?.hasAttribute(MERMAID_MOUNTED_ATTR) && block.parentNode) {
    block.parentNode.insertBefore(pre, block.nextSibling);
  } else if (block) {
    splitBlockAndInsert(block, range, pre, root);
  } else {
    range.insertNode(pre);
  }

  return root.contains(pre) ? mountMermaidSource(pre) : null;
}

/** Find source blocks that use either supported public HTML representation. */
export function findMermaidPreElements(root: ParentNode): HTMLPreElement[] {
  const candidates = Array.from(root.querySelectorAll<HTMLPreElement>('pre'));
  return candidates.filter((pre) => {
    if (pre.classList.contains('mermaid')) return true;
    return directLanguageMermaidCode(pre) !== null;
  });
}

/**
 * Add transient preview DOM while retaining the original source nodes inside
 * the <pre>. The inverse operation is {@link stripMermaidPresentation}.
 */
export function mountMermaidSource(pre: HTMLPreElement): MermaidSourceBlock {
  const existing = mountedBlock(pre);
  if (existing) return existing;

  const code = pre.classList.contains('mermaid') ? null : directLanguageMermaidCode(pre);
  const kind: MermaidKind = code ? 'code' : 'pre';
  let source: HTMLElement;

  if (code) {
    source = code;
    source.setAttribute(MERMAID_SOURCE_ATTR, '');
  } else {
    const wrapper = document.createElement('span');
    wrapper.setAttribute(MERMAID_SOURCE_ATTR, '');
    while (pre.firstChild) wrapper.appendChild(pre.firstChild);
    pre.appendChild(wrapper);
    source = wrapper;
  }

  const preview = document.createElement('div');
  preview.setAttribute(MERMAID_PREVIEW_ATTR, '');
  preview.setAttribute(MERMAID_STATE_ATTR, 'loading');
  preview.setAttribute('contenteditable', 'false');
  preview.setAttribute('role', 'button');
  preview.setAttribute('tabindex', '0');
  preview.setAttribute('aria-label', 'Edit Mermaid diagram');
  preview.setAttribute('aria-busy', 'true');
  setStatusText(preview, 'Loading Mermaid diagram…');

  pre.setAttribute(MERMAID_MOUNTED_ATTR, '');
  pre.setAttribute(MERMAID_KIND_ATTR, kind);
  pre.setAttribute(
    MERMAID_EDITABLE_ATTR,
    pre.hasAttribute('contenteditable')
      ? pre.getAttribute('contenteditable') ?? ''
      : MISSING_ATTRIBUTE,
  );
  pre.setAttribute('contenteditable', 'false');
  pre.appendChild(preview);
  return { pre, source, preview, kind };
}

export function readMermaidSource(block: MermaidSourceBlock): string {
  return block.source.textContent ?? '';
}

export function writeMermaidSource(block: MermaidSourceBlock, value: string): void {
  block.source.replaceChildren(document.createTextNode(value));
}

export function setMermaidLoading(block: MermaidSourceBlock): void {
  block.preview.setAttribute(MERMAID_STATE_ATTR, 'loading');
  block.preview.setAttribute('aria-busy', 'true');
  setStatusText(block.preview, 'Rendering Mermaid diagram…');
}

export function setMermaidError(block: MermaidSourceBlock, error: unknown): void {
  block.preview.setAttribute(MERMAID_STATE_ATTR, 'error');
  block.preview.removeAttribute('aria-busy');
  const message = document.createElement('span');
  message.setAttribute('data-ahve-mermaid-error', '');
  message.textContent = safeErrorMessage(error);
  block.preview.replaceChildren(message);
}

export function setMermaidSvg(block: MermaidSourceBlock, svg: string): boolean {
  const template = document.createElement('template');
  template.innerHTML = svg;
  const element = template.content.firstElementChild;
  if (!(element instanceof SVGSVGElement)) {
    setMermaidError(block, new Error('Mermaid did not return an SVG diagram.'));
    return false;
  }

  block.preview.setAttribute(MERMAID_STATE_ATTR, 'ready');
  block.preview.removeAttribute('aria-busy');
  block.preview.replaceChildren(element);
  return true;
}

/** True when a text node belongs to retained source that is hidden in the view. */
export function isInMermaidSource(node: Node, root: Element): boolean {
  let current: Node | null = node.parentNode;
  while (current && current !== root) {
    if (current instanceof Element && current.hasAttribute(MERMAID_SOURCE_ATTR)) return true;
    current = current.parentNode;
  }
  return false;
}

/**
 * Remove every generated preview and transient marker from a live or cloned
 * subtree, restoring the exact public HTML shape that was mounted.
 */
export function stripMermaidPresentation(scope: ParentNode): void {
  for (const pre of Array.from(
    scope.querySelectorAll<HTMLPreElement>(`pre[${MERMAID_MOUNTED_ATTR}]`),
  )) {
    for (const preview of directChildrenWithAttribute(pre, MERMAID_PREVIEW_ATTR)) {
      preview.remove();
    }

    const kind = pre.getAttribute(MERMAID_KIND_ATTR);
    const source = directChildrenWithAttribute(pre, MERMAID_SOURCE_ATTR)[0] ?? null;
    if (kind === 'pre' && source) {
      unwrap(source);
    } else if (source) {
      source.removeAttribute(MERMAID_SOURCE_ATTR);
    }
    pre.removeAttribute(MERMAID_MOUNTED_ATTR);
    pre.removeAttribute(MERMAID_KIND_ATTR);
    const originalEditable = pre.getAttribute(MERMAID_EDITABLE_ATTR);
    if (originalEditable === MISSING_ATTRIBUTE || originalEditable === null) {
      pre.removeAttribute('contenteditable');
    } else {
      pre.setAttribute('contenteditable', originalEditable);
    }
    pre.removeAttribute(MERMAID_EDITABLE_ATTR);
  }
}

function mountedBlock(pre: HTMLPreElement): MermaidSourceBlock | null {
  if (!pre.hasAttribute(MERMAID_MOUNTED_ATTR)) return null;
  const kind = pre.getAttribute(MERMAID_KIND_ATTR);
  if (kind !== 'pre' && kind !== 'code') return null;
  const source = directChildrenWithAttribute(pre, MERMAID_SOURCE_ATTR)[0] ?? null;
  const preview = directChildrenWithAttribute(pre, MERMAID_PREVIEW_ATTR)[0] ?? null;
  return source && preview ? { pre, source, preview, kind } : null;
}

function directLanguageMermaidCode(pre: HTMLPreElement): HTMLElement | null {
  for (const child of Array.from(pre.children)) {
    if (child.tagName === 'CODE' && child.classList.contains('language-mermaid')) {
      return child as HTMLElement;
    }
  }
  return null;
}

function directChildrenWithAttribute(parent: Element, attribute: string): HTMLElement[] {
  return Array.from(parent.children).filter(
    (child): child is HTMLElement => child instanceof HTMLElement && child.hasAttribute(attribute),
  );
}

function setStatusText(preview: HTMLElement, value: string): void {
  const status = document.createElement('span');
  status.setAttribute('data-ahve-mermaid-status', '');
  status.textContent = value;
  preview.replaceChildren(status);
}

function safeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const firstLine = raw.split(/\r?\n/, 1)[0]?.trim() ?? '';
  const compact = firstLine.replace(/^Error:\s*/i, '').slice(0, 240);
  return compact ? `Mermaid error: ${compact}` : 'Unable to render Mermaid diagram.';
}

/**
 * Split the caret's current block so the diagram occupies a real block
 * boundary. Lists are split outside their container, matching table insertion.
 */
function splitBlockAndInsert(
  block: HTMLElement,
  range: Range,
  pre: HTMLPreElement,
  root: HTMLElement,
): void {
  let target = block;
  let splitRange = range;
  if (block.tagName === 'LI') {
    const list = block.closest('ul, ol');
    if (list && list !== root) {
      target = list;
      splitRange = document.createRange();
      splitRange.setStart(range.startContainer, range.startOffset);
      splitRange.setEndAfter(block);
    }
  }

  const parent = target.parentNode;
  if (!parent) return;

  const afterRange = document.createRange();
  afterRange.setStart(splitRange.startContainer, splitRange.startOffset);
  afterRange.setEndAfter(target);
  const afterFragment = afterRange.extractContents();

  parent.insertBefore(pre, target.nextSibling);
  if (afterFragment.childNodes.length > 0) {
    parent.insertBefore(afterFragment, pre.nextSibling);
  }

  if (isBlockEmptyOrStubBr(target)) target.remove();
  const trailing = pre.nextSibling;
  if (trailing instanceof HTMLElement && isBlockEmptyOrStubBr(trailing)) {
    trailing.remove();
  }
}
