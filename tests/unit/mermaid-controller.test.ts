import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountMermaid, themeFromBody } from '../../webview/features/mermaid/mermaid';
import type { MermaidRuntime } from '../../webview/features/mermaid/runtime-api';

afterEach(() => {
  document.body.replaceChildren();
  document.body.removeAttribute('class');
  vi.restoreAllMocks();
});

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('Mermaid controller', () => {
  it('does not load the runtime when no Mermaid source exists', async () => {
    const root = document.createElement('div');
    root.innerHTML = '<p>ordinary</p>';
    document.body.appendChild(root);
    const loadRuntime = vi.fn<() => Promise<MermaidRuntime>>();
    const controller = mountMermaid(root, {
      runtimeUrl: null,
      nonce: '',
      onEdit: vi.fn(),
      loadRuntime,
    });

    controller.refresh();
    await tick();
    expect(loadRuntime).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('renders supported blocks sequentially with the current theme', async () => {
    const root = document.createElement('div');
    root.innerHTML =
      '<pre class="mermaid">graph TD</pre>' +
      '<pre><code class="language-mermaid">sequenceDiagram</code></pre>';
    document.body.appendChild(root);
    const initialize = vi.fn();
    const render = vi.fn((id: string, source: string) =>
      Promise.resolve(`<svg data-id="${id}"><text>${source}</text></svg>`));
    const runtime: MermaidRuntime = {
      initialize,
      render,
    };
    const controller = mountMermaid(root, {
      runtimeUrl: null,
      nonce: '',
      onEdit: vi.fn(),
      loadRuntime: () => Promise.resolve(runtime),
    });

    controller.refresh();
    await tick();
    await tick();

    expect(initialize).toHaveBeenCalledWith('default');
    expect(render).toHaveBeenCalledTimes(2);
    expect(root.querySelectorAll('svg')).toHaveLength(2);
    controller.dispose();
  });

  it('applies a dialog edit as one source change and re-renders it', async () => {
    const root = document.createElement('div');
    root.innerHTML = '<pre class="mermaid">graph TD</pre>';
    document.body.appendChild(root);
    const onEdit = vi.fn();
    const render = vi.fn((_id: string, source: string) =>
      Promise.resolve(`<svg><text>${source}</text></svg>`));
    const runtime: MermaidRuntime = {
      initialize: vi.fn(),
      render,
    };
    const openDialog = vi.fn(() => Promise.resolve({
      action: 'apply' as const,
      source: 'graph LR\nA-->B',
    }));
    const controller = mountMermaid(root, {
      runtimeUrl: null,
      nonce: '',
      onEdit,
      loadRuntime: () => Promise.resolve(runtime),
      openDialog,
    });
    controller.refresh();
    await tick();
    await tick();

    (root.querySelector('[data-ahve-mermaid-preview]') as HTMLElement).click();
    await tick();
    await tick();

    expect(openDialog).toHaveBeenCalledWith('graph TD');
    expect(onEdit).toHaveBeenCalledOnce();
    expect(onEdit).toHaveBeenCalledWith('Edit Mermaid diagram');
    expect(root.textContent).toContain('graph LR\nA-->B');
    expect(render).toHaveBeenLastCalledWith(
      expect.stringMatching(/^ahve-mermaid-/),
      'graph LR\nA-->B',
    );
    controller.dispose();
  });

  it('deletes a diagram from its edit dialog as one source change', async () => {
    const root = document.createElement('div');
    root.innerHTML = '<h2>Before</h2><pre class="mermaid">graph TD</pre><p>After</p>';
    document.body.appendChild(root);
    const onEdit = vi.fn();
    const controller = mountMermaid(root, {
      runtimeUrl: null,
      nonce: '',
      onEdit,
      loadRuntime: () => Promise.resolve({
        initialize: vi.fn(),
        render: vi.fn(() => Promise.resolve('<svg></svg>')),
      }),
      openDialog: vi.fn(() => Promise.resolve({ action: 'delete' as const })),
    });
    controller.refresh();
    await tick();
    await tick();

    (root.querySelector('[data-ahve-mermaid-preview]') as HTMLElement).click();
    await tick();

    expect(root.querySelector('pre')).toBeNull();
    expect(root.innerHTML).toBe('<h2>Before</h2><p>After</p>');
    expect(onEdit).toHaveBeenCalledOnce();
    expect(onEdit).toHaveBeenCalledWith('Delete Mermaid diagram');
    controller.dispose();
  });

  it('opens the dialog immediately and inserts its source at the saved caret', async () => {
    const root = document.createElement('div');
    root.innerHTML = '<p>Before</p><p>After</p>';
    document.body.appendChild(root);
    const first = root.querySelector('p')!;
    const range = document.createRange();
    range.selectNodeContents(first);
    range.collapse(false);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    const onEdit = vi.fn();
    const openDialog = vi.fn(() => Promise.resolve({
      action: 'apply' as const,
      source: 'sequenceDiagram\n  A->>B: Hello',
    }));
    const render = vi.fn(() => Promise.resolve('<svg></svg>'));
    const controller = mountMermaid(root, {
      runtimeUrl: null,
      nonce: '',
      onEdit,
      loadRuntime: () => Promise.resolve({ initialize: vi.fn(), render }),
      openDialog,
    });

    controller.insert();
    await tick();
    await tick();

    expect(openDialog).toHaveBeenCalledWith('graph TD\n  A --> B', { allowDelete: false });
    expect(Array.from(root.children).map((element) => element.tagName)).toEqual([
      'P',
      'PRE',
      'P',
    ]);
    expect(root.querySelector('[data-ahve-mermaid-source]')?.textContent).toBe(
      'sequenceDiagram\n  A->>B: Hello',
    );
    expect(onEdit).toHaveBeenCalledOnce();
    expect(onEdit).toHaveBeenCalledWith('Insert Mermaid diagram');
    expect(render).toHaveBeenCalledWith(
      expect.stringMatching(/^ahve-mermaid-/),
      'sequenceDiagram\n  A->>B: Hello',
    );
    controller.dispose();
  });

  it('leaves the document unchanged when Mermaid insertion is cancelled', async () => {
    const root = document.createElement('div');
    root.innerHTML = '<p>Before</p>';
    document.body.appendChild(root);
    const range = document.createRange();
    range.selectNodeContents(root.querySelector('p')!);
    range.collapse(false);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    const onEdit = vi.fn();
    const controller = mountMermaid(root, {
      runtimeUrl: null,
      nonce: '',
      onEdit,
      loadRuntime: vi.fn(),
      openDialog: vi.fn(() => Promise.resolve({ action: 'cancel' as const })),
    });

    controller.insert();
    await tick();

    expect(root.innerHTML).toBe('<p>Before</p>');
    expect(onEdit).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('discards a render result made stale by a later refresh', async () => {
    const root = document.createElement('div');
    root.innerHTML = '<pre class="mermaid">first</pre>';
    document.body.appendChild(root);
    let resolveFirst: ((svg: string) => void) | null = null;
    const runtime: MermaidRuntime = {
      initialize: vi.fn(),
      render: vi.fn((_id, source) => {
        if (source === 'first') {
          return new Promise<string>((resolve) => { resolveFirst = resolve; });
        }
        return Promise.resolve(`<svg><text>${source}</text></svg>`);
      }),
    };
    const controller = mountMermaid(root, {
      runtimeUrl: null,
      nonce: '',
      onEdit: vi.fn(),
      loadRuntime: () => Promise.resolve(runtime),
    });
    controller.refresh();
    await tick();

    const pre = root.querySelector('pre')!;
    pre.replaceWith(Object.assign(document.createElement('pre'), {
      className: 'mermaid',
      textContent: 'second',
    }));
    controller.refresh();
    resolveFirst?.('<svg><text>stale</text></svg>');
    await tick();
    await tick();

    expect(root.querySelector('[data-ahve-mermaid-preview]')?.textContent).toBe('second');
    controller.dispose();
  });

  it('maps VS Code body classes to Mermaid themes', () => {
    expect(themeFromBody(document.body)).toBe('default');
    document.body.className = 'vscode-dark';
    expect(themeFromBody(document.body)).toBe('dark');
    document.body.className = 'vscode-high-contrast';
    expect(themeFromBody(document.body)).toBe('dark');
    document.body.className = 'vscode-high-contrast-light';
    expect(themeFromBody(document.body)).toBe('default');
  });
});
