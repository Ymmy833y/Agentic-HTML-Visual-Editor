import { openMermaidDialog, type MermaidDialogResult } from '../../ui/mermaid-dialog';
import {
  DEFAULT_MERMAID_SOURCE,
  findMermaidPreElements,
  insertMermaidAtSelection,
  MERMAID_PREVIEW_ATTR,
  mountMermaidSource,
  readMermaidSource,
  setMermaidError,
  setMermaidLoading,
  setMermaidSvg,
  writeMermaidSource,
  type MermaidSourceBlock,
} from './mermaid-dom';
import {
  MERMAID_RUNTIME_GLOBAL,
  MERMAID_RUNTIME_READY_EVENT,
  type MermaidRuntime,
  type MermaidTheme,
} from './runtime-api';

export interface MermaidController {
  refresh(): void;
  insert(): void;
  dispose(): void;
}

export interface MermaidControllerOptions {
  runtimeUrl: string | null;
  nonce: string;
  onEdit: (label: string) => void;
  loadRuntime?: () => Promise<MermaidRuntime>;
  openDialog?: (
    source: string,
    options?: { allowDelete?: boolean },
  ) => Promise<MermaidDialogResult>;
  themeHost?: HTMLElement;
}

export function mountMermaid(
  root: HTMLElement,
  options: MermaidControllerOptions,
): MermaidController {
  const loadRuntime = options.loadRuntime ?? createRuntimeLoader(options.runtimeUrl, options.nonce);
  const openDialog = options.openDialog ?? openMermaidDialog;
  const themeHost = options.themeHost ?? document.body;
  let generation = 0;
  let renderSequence = 0;
  let renderQueue = Promise.resolve();
  let editing = false;
  let currentTheme = themeFromBody(themeHost);

  const refresh = (): void => {
    const blocks = findMermaidPreElements(root).map(mountMermaidSource);
    const jobGeneration = ++generation;
    if (blocks.length === 0) return;
    for (const block of blocks) setMermaidLoading(block);

    const run = async (): Promise<void> => {
      if (jobGeneration !== generation) return;
      let runtime: MermaidRuntime;
      try {
        runtime = await loadRuntime();
        runtime.initialize(currentTheme);
      } catch (error) {
        if (jobGeneration === generation) {
          for (const block of blocks) {
            if (block.pre.isConnected) setMermaidError(block, error);
          }
        }
        return;
      }

      for (const block of blocks) {
        if (jobGeneration !== generation) return;
        if (!block.pre.isConnected) continue;
        const source = readMermaidSource(block);
        const id = `ahve-mermaid-${++renderSequence}`;
        try {
          const svg = await runtime.render(id, source);
          if (
            jobGeneration === generation &&
            block.pre.isConnected &&
            readMermaidSource(block) === source
          ) {
            setMermaidSvg(block, svg);
          }
        } catch (error) {
          if (
            jobGeneration === generation &&
            block.pre.isConnected &&
            readMermaidSource(block) === source
          ) {
            setMermaidError(block, error);
          }
        }
      }
    };

    renderQueue = renderQueue.then(run, run);
  };

  const blockFromEvent = (event: Event): MermaidSourceBlock | null => {
    const target = event.target instanceof Element ? event.target : null;
    const preview = target?.closest<HTMLElement>(`[${MERMAID_PREVIEW_ATTR}]`) ?? null;
    if (!preview || !root.contains(preview)) return null;
    const pre = preview.parentElement;
    return pre instanceof HTMLPreElement ? mountMermaidSource(pre) : null;
  };

  const editBlock = async (block: MermaidSourceBlock): Promise<void> => {
    if (editing) return;
    editing = true;
    try {
      const result = await openDialog(readMermaidSource(block));
      if (result.action === 'delete' && block.pre.isConnected) {
        const parent = block.pre.parentNode;
        const offset = parent ? Array.prototype.indexOf.call(parent.childNodes, block.pre) : 0;
        block.pre.remove();
        options.onEdit('Delete Mermaid diagram');
        refresh();
        if (parent?.isConnected) placeCaret(parent, offset, root);
        return;
      }
      if (result.action !== 'apply' || !block.pre.isConnected) return;
      writeMermaidSource(block, result.source);
      options.onEdit('Edit Mermaid diagram');
      refresh();
      block.preview.focus({ preventScroll: true });
    } finally {
      editing = false;
    }
  };

  const onMouseDown = (event: MouseEvent): void => {
    if (blockFromEvent(event)) event.preventDefault();
  };
  const onClick = (event: MouseEvent): void => {
    const block = blockFromEvent(event);
    if (!block) return;
    event.preventDefault();
    event.stopPropagation();
    void editBlock(block);
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const block = blockFromEvent(event);
    if (!block) return;
    event.preventDefault();
    event.stopPropagation();
    void editBlock(block);
  };

  root.addEventListener('mousedown', onMouseDown, true);
  root.addEventListener('click', onClick);
  root.addEventListener('keydown', onKeyDown, true);

  const themeObserver = new MutationObserver(() => {
    const nextTheme = themeFromBody(themeHost);
    if (nextTheme === currentTheme) return;
    currentTheme = nextTheme;
    refresh();
  });
  themeObserver.observe(themeHost, { attributes: true, attributeFilter: ['class'] });

  return {
    refresh,
    insert(): void {
      if (editing) return;
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) return;
      const range = selection.getRangeAt(0);
      if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return;
      const savedRange = range.cloneRange();

      editing = true;
      void openDialog(DEFAULT_MERMAID_SOURCE, { allowDelete: false })
        .then((result) => {
          if (result.action !== 'apply') return;
          if (
            !root.contains(savedRange.startContainer) ||
            !root.contains(savedRange.endContainer)
          ) {
            return;
          }
          const liveSelection = window.getSelection();
          if (!liveSelection) return;
          root.focus({ preventScroll: true });
          liveSelection.removeAllRanges();
          liveSelection.addRange(savedRange);
          const block = insertMermaidAtSelection(root, result.source);
          if (!block) return;
          options.onEdit('Insert Mermaid diagram');
          refresh();
          block.preview.focus({ preventScroll: true });
        })
        .finally(() => {
          editing = false;
        });
    },
    dispose(): void {
      generation++;
      themeObserver.disconnect();
      root.removeEventListener('mousedown', onMouseDown, true);
      root.removeEventListener('click', onClick);
      root.removeEventListener('keydown', onKeyDown, true);
    },
  };
}

function placeCaret(parent: Node, offset: number, root: HTMLElement): void {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.setStart(parent, Math.min(offset, parent.childNodes.length));
  range.collapse(true);
  root.focus({ preventScroll: true });
  selection.removeAllRanges();
  selection.addRange(range);
}

export function themeFromBody(body: Element): MermaidTheme {
  return body.classList.contains('vscode-dark') || body.classList.contains('vscode-high-contrast')
    ? 'dark'
    : 'default';
}

function createRuntimeLoader(
  runtimeUrl: string | null,
  nonce: string,
): () => Promise<MermaidRuntime> {
  let pending: Promise<MermaidRuntime> | null = null;
  return async (): Promise<MermaidRuntime> => {
    const ready = window[MERMAID_RUNTIME_GLOBAL];
    if (ready) return ready;
    if (!runtimeUrl) throw new Error('Mermaid runtime URL is unavailable.');
    if (!pending) {
      pending = loadRuntimeScript(runtimeUrl, nonce).catch((error: unknown) => {
        pending = null;
        throw error;
      });
    }
    return pending;
  };
}

function loadRuntimeScript(runtimeUrl: string, nonce: string): Promise<MermaidRuntime> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const script = document.createElement('script');
    script.src = runtimeUrl;
    script.async = true;
    if (nonce) script.nonce = nonce;

    const cleanup = (): void => {
      window.removeEventListener(MERMAID_RUNTIME_READY_EVENT, onReady);
      script.removeEventListener('load', onReady);
      script.removeEventListener('error', onError);
    };
    const onReady = (): void => {
      if (settled) return;
      const runtime = window[MERMAID_RUNTIME_GLOBAL];
      if (!runtime) {
        settled = true;
        cleanup();
        reject(new Error('Mermaid runtime did not initialize.'));
        return;
      }
      settled = true;
      cleanup();
      resolve(runtime);
    };
    const onError = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      script.remove();
      reject(new Error('Unable to load Mermaid runtime.'));
    };

    window.addEventListener(MERMAID_RUNTIME_READY_EVENT, onReady);
    script.addEventListener('load', onReady);
    script.addEventListener('error', onError);
    document.head.appendChild(script);
  });
}
