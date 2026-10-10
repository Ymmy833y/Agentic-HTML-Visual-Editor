import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BlockCommandPorts } from '../../webview/editing/block-command';
import { readSelectionRange } from '../../webview/editing/caret';
import { handleDetailsClick, handleDetailsPointerDown } from '../../webview/editing/details-marker';
import { ensureTargetBlock } from '../../webview/editing/target-block';
import { mountRoot, readElement } from './helpers/format-dom';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('routing a title click', () => {
  it('lets no exception escape an area check that throws, and does not toggle, while keeping the default toggle stopped', () => {
    const root = mountRoot('<details><summary>t</summary>\n<p>b</p></details>');
    const section = readElement(root, 'details');
    const diagnostics: string[] = [];
    const ports: BlockCommandPorts = {
      readEditorRoot: () => root,
      isComposing: () => false,
      isInputStopped: () => false,
      runCommandEdit: (kind, command) => command(),
      ensureTargetBlock: () => ensureTargetBlock(root, readSelectionRange(root)),
      reportDiagnostic: (detail) => diagnostics.push(detail),
    };
    root.addEventListener('click', (event) => handleDetailsClick(ports, root, event));
    vi.spyOn(window, 'getComputedStyle').mockImplementation(() => {
      throw new Error('could not read the computed value');
    });

    const event = new MouseEvent('click', {
      button: 0,
      detail: 1,
      bubbles: true,
      cancelable: true,
    });
    readElement(root, 'summary').dispatchEvent(event);

    expect([event.defaultPrevented, section.hasAttribute('open'), diagnostics.length])
      .toEqual([true, false, 1]);
  });
});

describe('routing a title press', () => {
  it('lets no exception escape an area check that throws, leaves the default alone, and leaves one diagnostic line', () => {
    const root = mountRoot('<details><summary>t</summary>\n<p>b</p></details>');
    const diagnostics: string[] = [];
    root.addEventListener('mousedown', (event) => {
      handleDetailsPointerDown(root, event, (detail) => diagnostics.push(detail));
    });
    vi.spyOn(window, 'getComputedStyle').mockImplementation(() => {
      throw new Error('could not read the computed value');
    });

    const event = new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true });
    readElement(root, 'summary').dispatchEvent(event);

    expect([event.defaultPrevented, diagnostics.length]).toEqual([false, 1]);
  });
});
