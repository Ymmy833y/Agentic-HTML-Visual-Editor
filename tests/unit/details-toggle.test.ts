import { describe, expect, it } from 'vitest';

import type { BlockCommandPorts } from '../../webview/editing/block-command';
import { readSelectionRange } from '../../webview/editing/caret';
import {
  DETAILS_TOGGLE_EDIT_KIND,
  escapeSelectionToTitle,
  openDetailsSection,
  toggleDetailsSection,
} from '../../webview/editing/details-toggle';
import { ensureTargetBlock } from '../../webview/editing/target-block';
import { createRange, mountRoot, readChildText, readElement, select } from './helpers/format-dom';

/** Ports to override. Any left out behave the same as in the real environment. */
interface PortOverrides {
  readonly isComposing?: () => boolean;
  readonly isInputStopped?: () => boolean;
  readonly runCommandEdit?: BlockCommandPorts['runCommandEdit'];
}

/**
 * Creates a stub for the block command ports, along with a record of opened attempts.
 *
 * The command path closes as complete only when the tree changed, the same as in the real
 * environment. Without being called in the same order, there would be no way to tell whether an
 * attempt was opened.
 *
 * @param root The editor root.
 * @param overrides Ports to override.
 * @returns The ports, and the diagnostic/attempt records.
 */
function createPorts(root: HTMLElement, overrides: PortOverrides = {}): {
  ports: BlockCommandPorts;
  diagnostics: string[];
  attempts: string[];
} {
  const diagnostics: string[] = [];
  const attempts: string[] = [];
  const ports: BlockCommandPorts = {
    readEditorRoot: () => root,
    isComposing: overrides.isComposing ?? (() => false),
    isInputStopped: overrides.isInputStopped ?? (() => false),
    runCommandEdit: overrides.runCommandEdit ?? ((kind, command) => {
      attempts.push(`begin:${kind}`);
      const changed = command();
      attempts.push(changed ? 'complete' : 'abort');
      return changed;
    }),
    ensureTargetBlock: () => ensureTargetBlock(root, readSelectionRange(root)),
    reportDiagnostic: (detail) => diagnostics.push(detail),
  };
  return { ports, diagnostics, attempts };
}

describe('toggling open/closed', () => {
  it('sets open on a closed collapsible section, closing the attempt as complete, as one standalone edit', () => {
    const root = mountRoot('<details><summary>t</summary><p>b</p></details>');
    const section = readElement(root, 'details');
    const { ports, attempts } = createPorts(root);

    const changed = toggleDetailsSection(ports, section);

    expect([changed, section.hasAttribute('open'), attempts])
      .toEqual([true, true, [`begin:${DETAILS_TOGGLE_EDIT_KIND}`, 'complete']]);
  });

  it('removes open from an open collapsible section', () => {
    const root = mountRoot('<details open=""><summary>t</summary><p>b</p></details>');
    const section = readElement(root, 'details');
    const { ports } = createPorts(root);

    const changed = toggleDetailsSection(ports, section);

    expect([changed, section.hasAttribute('open')]).toEqual([true, false]);
  });

  it('toggles only the one collapsible section passed in, for nested collapsible sections', () => {
    const root = mountRoot(
      '<details open=""><summary>t</summary>'
      + '<details open=""><summary>u</summary><p>b</p></details></details>',
    );
    const { ports } = createPorts(root);

    toggleDetailsSection(ports, readElement(root, 'details details'));

    expect([
      readElement(root, 'details').hasAttribute('open'),
      readElement(root, 'details details').hasAttribute('open'),
    ]).toEqual([true, false]);
  });

  it('does not start an attempt or change the attribute during composition', () => {
    const root = mountRoot('<details><summary>t</summary></details>');
    const section = readElement(root, 'details');
    const { ports, attempts } = createPorts(root, { isComposing: () => true });

    const changed = toggleDetailsSection(ports, section);

    expect([changed, section.hasAttribute('open'), attempts]).toEqual([false, false, []]);
  });

  it('does not start an attempt or change the attribute while input is stopped', () => {
    const root = mountRoot('<details><summary>t</summary></details>');
    const section = readElement(root, 'details');
    const { ports, attempts } = createPorts(root, { isInputStopped: () => true });

    const changed = toggleDetailsSection(ports, section);

    expect([changed, section.hasAttribute('open'), attempts]).toEqual([false, false, []]);
  });

  it('returns false without changing the attribute when the attempt start is rejected', () => {
    const root = mountRoot('<details><summary>t</summary></details>');
    const section = readElement(root, 'details');
    const { ports } = createPorts(root, { runCommandEdit: () => false });

    const changed = toggleDetailsSection(ports, section);

    expect([changed, section.hasAttribute('open')]).toEqual([false, false]);
  });

  it('lets no exception escape a rewrite that throws, leaving one diagnostic line and closing as an abort', () => {
    const root = mountRoot('<details open=""><summary>t</summary></details>');
    const section = readElement(root, 'details');
    Object.defineProperty(section, 'removeAttribute', {
      value: () => {
        throw new Error('could not remove the attribute');
      },
    });
    const { ports, diagnostics, attempts } = createPorts(root);

    const changed = toggleDetailsSection(ports, section);

    expect([changed, diagnostics.length, attempts.at(-1)]).toEqual([false, 1, 'abort']);
  });
});

describe('Toggling in the open direction', () => {
  it('passing a closed details section with direction open opens it with one details:toggle edit', () => {
    const root = mountRoot('<details><summary>t</summary><p>b</p></details>');
    const section = readElement(root, 'details');
    const { ports, attempts } = createPorts(root);

    const changed = toggleDetailsSection(ports, section, 'open');

    expect([changed, section.hasAttribute('open'), attempts])
      .toEqual([true, true, [`begin:${DETAILS_TOGGLE_EDIT_KIND}`, 'complete']]);
  });

  it('passes the same pair as the third argument of runCommandEdit when edit endpoint selections are given with direction open', () => {
    const root = mountRoot('<details><summary>t</summary><p>b</p></details>');
    const section = readElement(root, 'details');
    const title = readChildText(readElement(root, 'summary'), 0);
    const endpoints = { start: createRange(title, 1, title, 1), end: null };
    const passed: unknown[] = [];
    const { ports } = createPorts(root, {
      runCommandEdit: (kind, command, given) => {
        passed.push(given);
        return command();
      },
    });

    toggleDetailsSection(ports, section, 'open', endpoints);

    expect([passed.length, passed[0] === endpoints]).toEqual([1, true]);
  });

  it('passing an open details section with direction open returns false without opening an attempt, and it stays open', () => {
    const root = mountRoot('<details open=""><summary>t</summary><p>b</p></details>');
    const section = readElement(root, 'details');
    const { ports, attempts } = createPorts(root);

    const changed = toggleDetailsSection(ports, section, 'open');

    expect([changed, section.hasAttribute('open'), attempts]).toEqual([false, true, []]);
  });
});

describe('reopening for a rule trigger', () => {
  it('changes neither the tree nor the return value for an already-open collapsible section', () => {
    const root = mountRoot('<details open=""><summary>t</summary></details>');
    const section = readElement(root, 'details');

    const opened = openDetailsSection(section);

    expect([opened, root.innerHTML])
      .toEqual([false, '<details open=""><summary>t</summary></details>']);
  });
});

describe('moving the selection out on close', () => {
  it('moves it to just before the placeholder when the title is empty', () => {
    const root = mountRoot('<details open=""><summary><br></summary>\n<p>body</p></details>');
    const text = readChildText(readElement(root, 'details > p'), 0);
    select(createRange(text, 0, text, 4));

    escapeSelectionToTitle(readElement(root, 'details'));

    const selection = window.getSelection();
    expect([
      selection?.anchorNode === readElement(root, 'summary'),
      selection?.anchorOffset,
      selection?.isCollapsed,
    ]).toEqual([true, 0, true]);
  });
});
