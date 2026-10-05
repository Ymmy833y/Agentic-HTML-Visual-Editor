import { afterEach, describe, expect, it, vi } from 'vitest';

import { EDITOR_ROOT_ELEMENT_ID, createLocalizer } from '../../common/index';
import type { DiagramRenderer, DiagramTheme } from '../../webview/diagram/diagram-render';
import {
  DIAGRAM_BLOCK_MARK_NAME,
  DIAGRAM_EMPTY_MARK_NAME,
  DIAGRAM_ERROR_MARK_NAME,
  DIAGRAM_MARK_NAME,
  DIAGRAM_MARK_NAMESPACE,
  DIAGRAM_SELECTED_MARK_NAME,
  DIAGRAM_ZOOMED_MARK_NAME,
  DiagramView,
} from '../../webview/diagram/diagram-view';
import { createRange, readChildText, readElement, select } from './helpers/format-dom';

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><rect width="1" height="1"/></svg>';

/** The set a test drives. */
interface Harness {
  readonly root: HTMLElement;
  readonly view: DiagramView;
  /** The sources and themes the renderer was asked to draw, in order. */
  readonly drawn: string[];
  /** The generated rules, in the order they were applied. */
  readonly rules: string[];
  /** The diagnostic lines. */
  readonly diagnostics: string[];
}

/**
 * Mounts a body and creates a diagram view whose renderer fails on sources containing `bad`.
 *
 * @param html The body.
 * @param load How the renderer loads. Defaults to a fake renderer.
 * @returns The harness.
 */
function createHarness(html: string, load?: () => Promise<DiagramRenderer>): Harness {
  document.body.replaceChildren();
  document.body.className = '';
  const root = document.createElement('div');
  root.id = EDITOR_ROOT_ELEMENT_ID;
  root.innerHTML = html;
  document.body.append(root);

  const drawn: string[] = [];
  const rules: string[] = [];
  const diagnostics: string[] = [];
  let theme: DiagramTheme = 'default';
  const renderer: DiagramRenderer = {
    initialize: (config) => {
      theme = config.theme ?? theme;
    },
    render: (_id, source) => {
      drawn.push(`${theme}:${source}`);
      // Settled in a later task, so that drawing that never ends leaves the timers of the waits running.
      return new Promise((resolve, reject) => {
        setTimeout(() => (source.includes('bad') ? reject(new Error('Parse error')) : resolve(SVG)), 0);
      });
    },
  };
  const view = new DiagramView(window, createLocalizer({}), document.documentElement, {
    readEditorRoot: () => root,
    loadRenderer: load ?? (() => Promise.resolve(renderer)),
    applyRules: (text) => rules.push(text),
    reportDiagnostic: (detail) => diagnostics.push(detail),
  });
  return { root, view, drawn, rules, diagnostics };
}

/** An editing session that only takes listeners. */
const SESSION = { addEditListener: () => undefined };

/**
 * Reads a mark of the first `pre`.
 *
 * @param root The editor root.
 * @param name The mark.
 * @returns The value, or `null` when absent.
 */
function readMark(root: Element, name: string): string | null {
  return readElement(root, 'pre').getAttributeNS(DIAGRAM_MARK_NAMESPACE, name);
}

describe('drawing diagram source blocks', () => {
  it('marks every diagram source block at once, and a drawn block with the rule that draws its image under that mark', async () => {
    const { root, view, rules } = createHarness('<pre class="mermaid">flowchart TD</pre><pre>plain</pre>');

    view.handleMountCompleted(SESSION);
    const marked = [...root.querySelectorAll('pre')].map((block) => block.hasAttributeNS(DIAGRAM_MARK_NAMESPACE, DIAGRAM_BLOCK_MARK_NAME));

    await vi.waitFor(() => expect(readMark(root, DIAGRAM_MARK_NAME)).not.toBeNull());
    const token = readMark(root, DIAGRAM_MARK_NAME);
    expect([marked, rules.at(-1)?.includes(`pre[*|${DIAGRAM_MARK_NAME}="${String(token)}"]::after`)]).toEqual([[true, false], true]);
  });

  it('marks a block that could not be drawn as an error and applies no rule for it', async () => {
    const { root, view, rules } = createHarness('<pre class="mermaid">bad</pre>');

    view.handleMountCompleted(SESSION);

    await vi.waitFor(() => expect(readMark(root, DIAGRAM_ERROR_MARK_NAME)).toBe(''));
    expect([readMark(root, DIAGRAM_MARK_NAME), rules]).toEqual([null, []]);
  });

  it('marks an empty block as empty and does not call the renderer for it', async () => {
    const { root, view, drawn } = createHarness('<pre class="mermaid">\n</pre>');

    view.handleMountCompleted(SESSION);
    await Promise.resolve();

    expect([readMark(root, DIAGRAM_EMPTY_MARK_NAME), readMark(root, DIAGRAM_MARK_NAME), readMark(root, DIAGRAM_ERROR_MARK_NAME), drawn])
      .toEqual(['', null, null, []]);
  });

  it('marks the same source from the kept result after the tree is replaced, without drawing again', async () => {
    const { root, view, drawn } = createHarness('<pre class="mermaid">flowchart TD</pre>');
    view.handleMountCompleted(SESSION);
    await vi.waitFor(() => expect(readMark(root, DIAGRAM_MARK_NAME)).not.toBeNull());

    root.innerHTML = '<p>a</p><pre class="mermaid">flowchart TD</pre>';
    view.handleMountCompleted(SESSION);

    expect([readMark(root, DIAGRAM_MARK_NAME) !== null, drawn]).toEqual([true, ['default:flowchart TD']]);
  });

  it('draws again with the dark theme when the body switches to a dark theme', async () => {
    const { root, view, drawn } = createHarness('<pre class="mermaid">flowchart TD</pre>');
    view.handleMountCompleted(SESSION);
    await vi.waitFor(() => expect(readMark(root, DIAGRAM_MARK_NAME)).not.toBeNull());

    document.body.classList.add('vscode-dark');

    await vi.waitFor(() => expect(drawn).toEqual(['default:flowchart TD', 'dark:flowchart TD']));
  });

  it('marks the blocks as errors and records one diagnostic line when the renderer cannot be loaded', async () => {
    const { root, view, diagnostics } = createHarness(
      '<pre class="mermaid">flowchart TD</pre>',
      () => Promise.reject(new Error('no module')),
    );

    view.handleMountCompleted(SESSION);

    await vi.waitFor(() => expect(readMark(root, DIAGRAM_ERROR_MARK_NAME)).toBe(''));
    expect([readMark(root, DIAGRAM_MARK_NAME), diagnostics.length]).toEqual([null, 1]);
  });

  it('marks every block of a body with more distinct sources than it keeps results for, drawing each source once', async () => {
    const sources = Array.from({ length: 70 }, (_, index) => (index % 10 === 0 ? `bad ${index}` : `flowchart TD\n  n${index}`));
    const { root, view, drawn } = createHarness(sources.map((source) => `<pre class="mermaid">${source}</pre>`).join(''));

    view.handleMountCompleted(SESSION);

    // Drawing 70 blocks one after another can outlast the default wait while the other test layers run alongside.
    await vi.waitFor(() => {
      const unmarked = [...root.querySelectorAll('pre')].filter((block) =>
        !block.hasAttributeNS(DIAGRAM_MARK_NAMESPACE, DIAGRAM_MARK_NAME)
        && !block.hasAttributeNS(DIAGRAM_MARK_NAMESPACE, DIAGRAM_ERROR_MARK_NAME));
      expect(unmarked).toEqual([]);
    }, { timeout: 5000 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(drawn).toHaveLength(sources.length);
  });

  it('removes the rule of a block that left the tree', async () => {
    const { root, view, rules } = createHarness('<pre class="mermaid">flowchart TD</pre>');
    view.handleMountCompleted(SESSION);
    await vi.waitFor(() => expect(rules).toHaveLength(1));

    root.innerHTML = '<p>a</p>';
    view.handleMountCompleted(SESSION);

    expect(rules.at(-1)).toBe('');
  });
});

describe('following the selection', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Selects a range and lets the view follow it in the next frame.
   *
   * @param range The range to select.
   */
  function selectAndFollow(range: Range): void {
    select(range);
    document.dispatchEvent(new Event('selectionchange'));
    vi.advanceTimersToNextFrame();
  }

  /**
   * Reads whether each `pre` has a mark.
   *
   * @param root The editor root.
   * @param name The mark.
   * @returns One flag per `pre`, in tree order.
   */
  function readMarks(root: Element, name: string): boolean[] {
    return [...root.querySelectorAll('pre')].map((block) => block.hasAttributeNS(DIAGRAM_MARK_NAMESPACE, name));
  }

  it('marks a diagram that a range wholly contains as selected, and unmarks it when the range leaves', async () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
    const { root, view } = createHarness('<p>ab</p><pre class="mermaid">flowchart TD</pre><p>cd</p>');
    view.handleMountCompleted(SESSION);
    await vi.waitFor(() => expect(readMark(root, DIAGRAM_MARK_NAME)).not.toBeNull());
    const before = readChildText(root.querySelectorAll('p')[0], 0);
    const after = readChildText(root.querySelectorAll('p')[1], 0);

    selectAndFollow(createRange(before, 1, after, 1));
    const across = readMarks(root, DIAGRAM_SELECTED_MARK_NAME);
    selectAndFollow(createRange(before, 1, before, 1));

    expect([across, readMarks(root, DIAGRAM_SELECTED_MARK_NAME)]).toEqual([[true], [false]]);
  });
});

describe('zooming diagrams', () => {
  /**
   * Mounts a body, waits until its first diagram is drawn, and reads the drawn width from its rule.
   *
   * @param html The body.
   * @returns The harness and the drawn width in px.
   */
  async function mountDrawn(html: string): Promise<Harness & { width: string }> {
    const harness = createHarness(html);
    harness.view.handleMountCompleted(SESSION);
    await vi.waitFor(() => expect(readMark(harness.root, DIAGRAM_MARK_NAME)).not.toBeNull());
    const width = /width: (\d+(?:\.\d+)?)px;/u.exec(harness.rules.at(-1) ?? '')?.[1] ?? '';
    return { ...harness, width };
  }

  it('scales the usual width of the image in its rule and puts the zoomed mark on the block', async () => {
    const { root, view, rules, width } = await mountDrawn('<pre class="mermaid">flowchart TD</pre>');

    const changed = view.zoomDiagram(readElement(root, 'pre'), 1.25);

    expect([changed, rules.at(-1)?.includes(`width: calc(min(${width}px, 100%) * 1.25); max-width: none;`), readMark(root, DIAGRAM_ZOOMED_MARK_NAME)])
      .toEqual([true, true, '']);
  });

  it('keeps the zoom level for the same source after the tree is replaced, and shows an edited source at 100%', async () => {
    const { root, view } = await mountDrawn('<pre class="mermaid">flowchart TD</pre>');
    view.zoomDiagram(readElement(root, 'pre'), 2);

    root.innerHTML = '<p>a</p><pre class="mermaid">flowchart TD</pre>';
    view.handleMountCompleted(SESSION);
    const kept = [view.readZoom(readElement(root, 'pre')), readMark(root, DIAGRAM_ZOOMED_MARK_NAME)];
    root.innerHTML = '<pre class="mermaid">flowchart LR</pre>';
    view.handleMountCompleted(SESSION);

    expect([...kept, view.readZoom(readElement(root, 'pre'))]).toEqual([2, '', 1]);
  });
});
