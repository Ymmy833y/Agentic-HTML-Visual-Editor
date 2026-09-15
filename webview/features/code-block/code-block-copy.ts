const COPY_BUTTON_CLASS = 'ahve-code-copy-btn';
const COPY_LAYER_CLASS = 'ahve-code-copy-layer';
const COPY_BUTTON_SIZE = 28;
const COPY_BUTTON_GAP = 6;
const COPIED_STATE_DURATION_MS = 1500;

export interface CodeBlockCopyOptions {
  onCopy(text: string): void;
}

export interface CodeBlockCopyController {
  refresh(): void;
  dispose(): void;
}

export function mountCodeBlockCopy(
  root: HTMLElement,
  options: CodeBlockCopyOptions,
): CodeBlockCopyController {
  const layer = document.createElement('div');
  layer.className = COPY_LAYER_CLASS;
  document.body.appendChild(layer);

  const buttons = new Map<HTMLPreElement, HTMLButtonElement>();
  const copiedTimers = new Map<HTMLButtonElement, number>();
  let refreshFrame: number | null = null;
  let positionFrame: number | null = null;
  let disposed = false;

  const markCopied = (button: HTMLButtonElement): void => {
    const currentTimer = copiedTimers.get(button);
    if (currentTimer !== undefined) window.clearTimeout(currentTimer);
    button.dataset.state = 'copied';
    button.title = 'Copied';
    button.setAttribute('aria-label', 'Copied code');
    const timer = window.setTimeout(() => {
      copiedTimers.delete(button);
      if (!button.isConnected) return;
      button.removeAttribute('data-state');
      button.title = 'Copy code';
      button.setAttribute('aria-label', 'Copy code');
    }, COPIED_STATE_DURATION_MS);
    copiedTimers.set(button, timer);
  };

  const removeButton = (pre: HTMLPreElement): void => {
    const button = buttons.get(pre);
    if (!button) return;
    const timer = copiedTimers.get(button);
    if (timer !== undefined) window.clearTimeout(timer);
    copiedTimers.delete(button);
    button.remove();
    buttons.delete(pre);
  };

  const updatePositions = (): void => {
    positionFrame = null;
    if (disposed) return;
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = document.documentElement.clientHeight;

    for (const [pre, button] of buttons) {
      if (!pre.isConnected || !root.contains(pre)) {
        removeButton(pre);
        continue;
      }

      const rect = pre.getBoundingClientRect();
      const left = rect.right + COPY_BUTTON_GAP;
      const top = rect.top;
      const visible =
        rect.bottom > 0 &&
        rect.top < viewportHeight &&
        left >= 0 &&
        left + COPY_BUTTON_SIZE <= viewportWidth;

      button.hidden = !visible;
      if (!visible) continue;
      button.style.left = `${left}px`;
      button.style.top = `${top}px`;
    }
  };

  const schedulePositionUpdate = (): void => {
    if (disposed || positionFrame !== null) return;
    positionFrame = window.requestAnimationFrame(updatePositions);
  };

  const createButton = (pre: HTMLPreElement): HTMLButtonElement => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = COPY_BUTTON_CLASS;
    button.title = 'Copy code';
    button.setAttribute('aria-label', 'Copy code');
    button.setAttribute('contenteditable', 'false');
    button.appendChild(createCopyIcon());

    button.addEventListener('mousedown', (event) => {
      event.preventDefault();
    });
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!pre.isConnected || !root.contains(pre)) return;
      options.onCopy(readCodeBlockText(pre));
      markCopied(button);
    });

    layer.appendChild(button);
    return button;
  };

  const refreshNow = (): void => {
    refreshFrame = null;
    if (disposed) return;

    const targets = new Set(
      Array.from(root.querySelectorAll<HTMLPreElement>('pre')).filter(
        (pre) => !isMermaidCodeBlock(pre),
      ),
    );

    for (const pre of Array.from(buttons.keys())) {
      if (!targets.has(pre)) removeButton(pre);
    }
    for (const pre of targets) {
      if (!buttons.has(pre)) buttons.set(pre, createButton(pre));
    }
    schedulePositionUpdate();
  };

  const scheduleRefresh = (): void => {
    if (disposed || refreshFrame !== null) return;
    refreshFrame = window.requestAnimationFrame(refreshNow);
  };

  const observer = new MutationObserver(scheduleRefresh);
  observer.observe(root, { childList: true, subtree: true });
  window.addEventListener('scroll', schedulePositionUpdate, true);
  window.addEventListener('resize', schedulePositionUpdate);

  refreshNow();

  return {
    refresh(): void {
      scheduleRefresh();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      observer.disconnect();
      window.removeEventListener('scroll', schedulePositionUpdate, true);
      window.removeEventListener('resize', schedulePositionUpdate);
      if (refreshFrame !== null) window.cancelAnimationFrame(refreshFrame);
      if (positionFrame !== null) window.cancelAnimationFrame(positionFrame);
      for (const timer of copiedTimers.values()) window.clearTimeout(timer);
      copiedTimers.clear();
      buttons.clear();
      layer.remove();
    },
  };
}

export function readCodeBlockText(pre: HTMLPreElement): string {
  let result = '';

  const visit = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      result += node.nodeValue ?? '';
      return;
    }
    if (!(node instanceof Element)) return;
    if (node.tagName === 'BR') {
      result += '\n';
      return;
    }
    for (const child of Array.from(node.childNodes)) visit(child);
  };

  for (const child of Array.from(pre.childNodes)) visit(child);
  return result;
}

function isMermaidCodeBlock(pre: HTMLPreElement): boolean {
  if (pre.classList.contains('mermaid')) return true;
  return Array.from(pre.children).some(
    (child) => child.tagName === 'CODE' && child.classList.contains('language-mermaid'),
  );
}

function createCopyIcon(): SVGSVGElement {
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(namespace, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');

  const back = document.createElementNS(namespace, 'rect');
  back.setAttribute('x', '5.5');
  back.setAttribute('y', '5.5');
  back.setAttribute('width', '8');
  back.setAttribute('height', '8');
  back.setAttribute('rx', '1');
  back.setAttribute('fill', 'none');
  back.setAttribute('stroke', 'currentColor');
  back.setAttribute('stroke-width', '1.4');

  const front = document.createElementNS(namespace, 'path');
  front.setAttribute('d', 'M10.5 4V2.8A1.3 1.3 0 0 0 9.2 1.5H2.8A1.3 1.3 0 0 0 1.5 2.8v6.4a1.3 1.3 0 0 0 1.3 1.3H4');
  front.setAttribute('fill', 'none');
  front.setAttribute('stroke', 'currentColor');
  front.setAttribute('stroke-width', '1.4');
  front.setAttribute('stroke-linecap', 'round');
  front.setAttribute('stroke-linejoin', 'round');

  svg.append(front, back);
  return svg;
}
