import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_MERMAID_SOURCE,
  findMermaidPreElements,
  insertMermaidAtSelection,
  isInMermaidSource,
  MERMAID_PREVIEW_ATTR,
  MERMAID_SOURCE_ATTR,
  mountMermaidSource,
  readMermaidSource,
  setMermaidError,
  setMermaidSvg,
  stripMermaidPresentation,
  writeMermaidSource,
} from '../../webview/features/mermaid/mermaid-dom';

afterEach(() => {
  document.body.replaceChildren();
});

function rootWith(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

describe('Mermaid source DOM', () => {
  it('recognizes both supported class-token representations', () => {
    const root = rootWith(
      '<pre class="mermaid extra">graph TD\nA-->B</pre>' +
      '<pre><code class="language-mermaid other">sequenceDiagram</code></pre>' +
      '<pre><code>ordinary</code></pre>' +
      '<code class="language-mermaid">not a block</code>',
    );

    expect(findMermaidPreElements(root)).toHaveLength(2);
  });

  it('mounts and strips a direct pre source without changing its public HTML', () => {
    const html = '<pre class="mermaid" data-name="x">graph TD\n  A --&gt; B\n</pre>';
    const root = rootWith(html);
    const pre = root.querySelector('pre')!;
    const block = mountMermaidSource(pre);

    expect(readMermaidSource(block)).toBe('graph TD\n  A --> B\n');
    expect(pre.getAttribute('contenteditable')).toBe('false');
    expect(pre.querySelector(`[${MERMAID_SOURCE_ATTR}]`)).not.toBeNull();
    expect(pre.querySelector(`[${MERMAID_PREVIEW_ATTR}]`)).not.toBeNull();

    const clone = root.cloneNode(true) as HTMLElement;
    stripMermaidPresentation(clone);
    expect(clone.innerHTML).toBe(html);
  });

  it('mounts and strips a language-mermaid code source while preserving attributes', () => {
    const html =
      '<pre data-name="outer"><code class="language-mermaid keep" data-name="inner">' +
      'sequenceDiagram\nA-&gt;&gt;B: Hi\n</code></pre>';
    const root = rootWith(html);
    const pre = root.querySelector('pre')!;
    const block = mountMermaidSource(pre);

    expect(block.kind).toBe('code');
    expect(readMermaidSource(block)).toContain('A->>B');

    const clone = root.cloneNode(true) as HTMLElement;
    stripMermaidPresentation(clone);
    expect(clone.innerHTML).toBe(html);
  });

  it('preserves a source contenteditable attribute through presentation cleanup', () => {
    const root = rootWith('<pre class="mermaid" contenteditable="true">graph TD</pre>');
    mountMermaidSource(root.querySelector('pre')!);

    const clone = root.cloneNode(true) as HTMLElement;
    stripMermaidPresentation(clone);
    expect(clone.innerHTML).toBe(
      '<pre class="mermaid" contenteditable="true">graph TD</pre>',
    );
  });

  it('updates only the retained source and removes generated SVG on cleanup', () => {
    const root = rootWith('<pre><code class="language-mermaid">graph TD</code></pre>');
    const block = mountMermaidSource(root.querySelector('pre')!);
    writeMermaidSource(block, 'graph LR\nA-->B');
    expect(setMermaidSvg(block, '<svg viewBox="0 0 10 10"><text>Diagram</text></svg>')).toBe(true);
    expect(root.querySelector('svg')?.textContent).toBe('Diagram');

    const clone = root.cloneNode(true) as HTMLElement;
    stripMermaidPresentation(clone);
    expect(clone.innerHTML).toBe(
      '<pre><code class="language-mermaid">graph LR\nA--&gt;B</code></pre>',
    );
  });

  it('renders errors as text and identifies hidden source text', () => {
    const root = rootWith('<pre class="mermaid">broken</pre>');
    const block = mountMermaidSource(root.querySelector('pre')!);
    const sourceText = block.source.firstChild!;
    expect(isInMermaidSource(sourceText, root)).toBe(true);

    setMermaidError(block, new Error('<img src=x onerror=alert(1)>\nstack'));
    expect(block.preview.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(block.preview.querySelector('img')).toBeNull();
  });

  it('inserts a Mermaid block at the caret and splits the current paragraph', () => {
    const root = rootWith('<p>beforeafter</p>');
    const text = root.querySelector('p')!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 6);
    range.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    const block = insertMermaidAtSelection(root);

    expect(block).not.toBeNull();
    expect(readMermaidSource(block!)).toBe(DEFAULT_MERMAID_SOURCE);
    const clone = root.cloneNode(true) as HTMLElement;
    stripMermaidPresentation(clone);
    expect(clone.innerHTML).toBe(
      '<p>before</p><pre class="mermaid">graph TD\n  A --&gt; B</pre><p>after</p>',
    );
  });

  it('does not insert when the selection is outside the editor', () => {
    const root = rootWith('<p>inside</p>');
    const outside = document.createElement('p');
    outside.textContent = 'outside';
    document.body.appendChild(outside);
    const range = document.createRange();
    range.selectNodeContents(outside);
    range.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    expect(insertMermaidAtSelection(root)).toBeNull();
    expect(root.querySelector('pre')).toBeNull();
  });
});
