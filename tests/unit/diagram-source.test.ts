import { describe, expect, it } from 'vitest';

import { findDiagramSources, isDiagramSource, readDiagramSource } from '../../webview/diagram/diagram-source';
import { createRoot, readElement } from './helpers/format-dom';

describe('recognizing diagram source blocks', () => {
  it('recognizes a pre carrying the mermaid class token among others', () => {
    const root = createRoot('<pre class="wide mermaid">flowchart TD</pre>');

    expect(isDiagramSource(readElement(root, 'pre'))).toBe(true);
  });

  it('recognizes a pre whose only child element is a code carrying the language-mermaid class token', () => {
    const root = createRoot('<pre><code class="language-mermaid">flowchart TD</code></pre>');

    expect(isDiagramSource(readElement(root, 'pre'))).toBe(true);
  });

  it('recognizes neither a pre without the token, a pre with another child element, nor a code outside pre', () => {
    const root = createRoot(
      '<pre class="mermaid-like">a</pre>'
      + '<pre><code class="language-mermaid">a</code><span>b</span></pre>'
      + '<p><code class="language-mermaid">a</code></p>',
    );

    expect([
      ...[...root.querySelectorAll('pre')].map(isDiagramSource),
      isDiagramSource(readElement(root, 'p > code')),
      findDiagramSources(root).length,
    ]).toEqual([false, false, false, 0]);
  });

  it('reads the source without the text of comment entries, reading br as a line break', () => {
    const root = createRoot(
      '<pre class="mermaid">flowchart TD<br><comment id="c-1">A<comment-body>note</comment-body></comment> --&gt; B</pre>',
    );

    expect(readDiagramSource(readElement(root, 'pre'))).toBe('flowchart TD\nA --> B');
  });
});
