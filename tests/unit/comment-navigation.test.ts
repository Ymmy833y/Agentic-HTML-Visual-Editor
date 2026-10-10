import { describe, expect, it } from 'vitest';

import {
  moveToAdjacentComment,
  readAdjacentComments,
  readClosedDetailsAncestors,
} from '../../webview/ui/comment-navigation';
import type { CommentNavigationPorts } from '../../webview/ui/comment-navigation';
import { mountRoot, readElement } from './helpers/format-dom';

/** Ports to override. Omitted ports stop nothing, as in the real environment. */
interface NavigationOverrides {
  readonly isInputStopped?: () => boolean;
  readonly commitInputs?: () => void;
}

/**
 * Creates a stand-in for the ports for moving, and a record of the call order.
 *
 * @param open Open comment.
 * @param overrides Ports to override.
 * @returns Ports, the record (commit, open:ID, switch:ID) and diagnostics.
 */
function createPorts(open: Element, overrides: NavigationOverrides = {}): {
  ports: CommentNavigationPorts;
  calls: string[];
  diagnostics: string[];
} {
  const calls: string[] = [];
  const diagnostics: string[] = [];
  const ports: CommentNavigationPorts = {
    readOpenComment: () => open,
    isInputStopped: overrides.isInputStopped ?? (() => false),
    commitInputs: overrides.commitInputs ?? (() => {
      calls.push('commit');
    }),
    openDetails: (section) => {
      calls.push(`open:${section.id}`);
      return true;
    },
    switchTo: (comment) => {
      calls.push(`switch:${comment.id}`);
    },
    reportDiagnostic: (detail) => {
      diagnostics.push(detail);
    },
  };
  return { ports, calls, diagnostics };
}

/**
 * Returns the ID of an element. A missing element gives `-`.
 *
 * @param element Element.
 * @returns ID.
 */
function readId(element: Element | undefined): string {
  return element?.id ?? '-';
}

describe('Looking up adjacent comments', () => {
  it('in start tag document order the next of a nested outer comment is the inner one, the first comment has no previous and the last has no next', () => {
    const root = mountRoot(
      '<p><comment id="a">x</comment><comment id="o">y<comment id="i">z</comment></comment><comment id="b">w</comment></p>',
    );

    const outer = readAdjacentComments(root, readElement(root, '#o'));
    const first = readAdjacentComments(root, readElement(root, '#a'));
    const last = readAdjacentComments(root, readElement(root, '#b'));

    expect([readId(outer.previous), readId(outer.next), readId(first.previous), readId(last.next)])
      .toEqual(['a', 'i', '-', '-']);
  });

  it('for a comment not in the editor root, neither exists', () => {
    const root = mountRoot('<p><comment id="a">x</comment></p>');
    const detached = document.createElement('comment');

    expect(readAdjacentComments(root, detached)).toEqual({ previous: undefined, next: undefined });
  });
});

describe('Closed ancestor details sections', () => {
  it('closed ancestors are listed outermost first, excluding open ancestors and closed ancestors whose title contains the target', () => {
    const root = mountRoot(
      '<details id="outer"><summary>t</summary><details id="middle" open=""><summary>t</summary>'
      + '<details id="inner"><summary>t</summary><p><comment id="a">x</comment></p></details></details></details>'
      + '<details id="titled"><summary><comment id="b">y</comment></summary><p>z</p></details>',
    );

    const inBody = readClosedDetailsAncestors(readElement(root, '#a'), root).map((section) => section.id);
    const inTitle = readClosedDetailsAncestors(readElement(root, '#b'), root).map((section) => section.id);

    expect([inBody, inTitle]).toEqual([['outer', 'inner'], []]);
  });

  it('returns the collapsible section when given a text node directly inside its closed body', () => {
    const root = mountRoot('<details id="d"><summary>t</summary>body</details>');
    const text = readElement(root, '#d').lastChild;
    if (text === null) {
      throw new Error('The body text node is missing');
    }

    expect(readClosedDetailsAncestors(text, root).map((section) => section.id)).toEqual(['d']);
  });

  it('returns only the outer section when given a text node in the title of a closed inner section inside a closed outer body', () => {
    const root = mountRoot(
      '<details id="outer"><summary>t</summary><details id="inner"><summary>title</summary><p>b</p></details></details>',
    );
    const text = readElement(root, '#inner > summary').firstChild;
    if (text === null) {
      throw new Error('The title text node is missing');
    }

    expect(readClosedDetailsAncestors(text, root).map((section) => section.id)).toEqual(['outer']);
  });
});

describe('Moving to adjacent comments', () => {
  it('while input is stopped, neither committing the inputs nor switching is called', () => {
    const root = mountRoot('<p><comment id="a">x</comment><comment id="b">y</comment></p>');
    const { ports, calls } = createPorts(readElement(root, '#a'), { isInputStopped: () => true });

    moveToAdjacentComment(root, 'next', ports);

    expect(calls).toEqual([]);
  });

  it('when the target has no rectangle, the inputs are committed but switching is not called', () => {
    // jsdom does not render, so a target without a given rectangle is treated as having no position.
    const root = mountRoot('<p><comment id="a">x</comment><comment id="b">y</comment></p>');
    const { ports, calls } = createPorts(readElement(root, '#a'));

    moveToAdjacentComment(root, 'next', ports);

    expect(calls).toEqual(['commit']);
  });

  it('an exception along the way does not escape and leaves one diagnostic line', () => {
    const root = mountRoot('<p><comment id="a">x</comment><comment id="b">y</comment></p>');
    const { ports, diagnostics } = createPorts(readElement(root, '#a'), {
      commitInputs: () => {
        throw new Error('cannot commit the inputs');
      },
    });

    moveToAdjacentComment(root, 'next', ports);

    expect(diagnostics.length).toBe(1);
  });
});
