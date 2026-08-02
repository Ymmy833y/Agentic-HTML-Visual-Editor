import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  NATIVE_PROBE,
  caretAtEnd,
  caretAtStart,
  focusEditor,
  getNativeProbeHtml,
  mountEditor,
  mountNativeProbe,
  recordProbeInputTypes,
} from './helpers/page';

// Exhaustive caret sweep around an inline <comment>. The comment's metadata
// (<comment-body>/<comment-reply>) is display:none + contenteditable=false, so
// the browser default deletion repeatedly mistakes it for "the next thing to
// delete" and wipes it out as collateral. This sweep is the permanent net: for
// every caret position in and around the comment, neither Backspace nor Delete
// may ever destroy the comment or its body.
//
// What the assertions below claim is exactly that — the annotation survives the
// keystroke — and NOT that the target text is untouched. The Ctrl variants can
// empty the 2-char target in one press (word granularity removes a whole word,
// and "di" is one), which leaves the comment rendering as nothing while its
// body is still intact. That is a legal intermediate state, not a loss: the
// next keystroke drops the emptied comment, which is what the pair of tests
// below "Word deletion around comments" pins down. An assertion that the target
// still holds text would therefore be wrong here, and adding one for a new case
// would be reading this net as something stronger than it is.
test.describe('Comment delete sweep — body must survive every Backspace/Delete', () => {
  const COMMENT =
    '<comment id="c-sweep01">di' +
    '<comment-body contenteditable="false" data-author="human" data-updated="2026-06-25T10:00:00.000Z">Comment</comment-body>' +
    '</comment>';

  /**
   * The same "Hea|di|ng" run, with the text on either side of the comment
   * optionally wrapped in an inline element — and, in the last two variants,
   * with the comment itself inside a wrapper. Chromium reads the whole run as
   * ONE word in every variant — a wrapper is not a word boundary — so every
   * variant is equally dangerous, and a guard that only looks at the caret's
   * own sibling list silently misses the wrapped ones. The wrapper selectors
   * are what makes the element-level caret positions addressable.
   *
   * The comment-wrapped variants are not an imported-HTML curiosity: commenting
   * the tail of a bold run produces them, because inline-format segments at
   * comment boundaries (see commands/inline-format), so the <strong> ends up
   * holding the <comment>. There the text a deletion reaches is OUTSIDE the
   * wrapper, which is the mirror of the cases above and the one a lookup along
   * the comment's own sibling list answers "nothing there" for.
   */
  interface Fixture {
    name: string;
    html: string;
    /** Selector of the wrapper around "Hea", or null when it is bare block text. */
    beforeWrapper: string | null;
    /** Selector of the wrapper around "ng", or null when it is bare block text. */
    afterWrapper: string | null;
    /** Selector of the wrapper holding the comment, or null when it is a direct
     *  child of the block. */
    commentWrapper: string | null;
  }

  const FIXTURES: Fixture[] = [
    {
      name: 'bare',
      html: `<h2>Hea${COMMENT}ng</h2>`,
      beforeWrapper: null,
      afterWrapper: null,
      commentWrapper: null,
    },
    {
      name: 'after-wrapped',
      html: `<h2>Hea${COMMENT}<strong>ng</strong></h2>`,
      beforeWrapper: null,
      afterWrapper: 'strong',
      commentWrapper: null,
    },
    {
      name: 'before-wrapped',
      html: `<h2><em>Hea</em>${COMMENT}ng</h2>`,
      beforeWrapper: 'em',
      afterWrapper: null,
      commentWrapper: null,
    },
    {
      name: 'both-wrapped',
      html: `<h2><em>Hea</em>${COMMENT}<strong>ng</strong></h2>`,
      beforeWrapper: 'em',
      afterWrapper: 'strong',
      commentWrapper: null,
    },
    {
      name: 'comment-wrapped-with-before',
      html: `<h2><em>Hea${COMMENT}</em>ng</h2>`,
      beforeWrapper: 'em',
      afterWrapper: null,
      commentWrapper: 'em',
    },
    {
      name: 'comment-wrapped-with-after',
      html: `<h2>Hea<strong>${COMMENT}ng</strong></h2>`,
      beforeWrapper: null,
      afterWrapper: 'strong',
      commentWrapper: 'strong',
    },
  ];

  // Collapsed-caret positions, named by where they sit relative to the comment.
  // The `-inner-elem` positions only exist when that side is wrapped: they are
  // the element-level caret at the wrapper's inner edge, where the caret's own
  // child list holds nothing beside it and the comment is reachable only by
  // stepping out of the wrapper. The `comment-wrapper-` pair is their mirror —
  // the wrapper's inner edge on the far side of a comment it CONTAINS, where
  // what the deletion reaches lies outside the wrapper.
  const POSITIONS = [
    'hea-start', // start of "Hea"
    'hea-mid', // "He|a"
    'before-comment', // "Hea|" — right before the comment
    'before-comment-inner-elem', // element-level at the end of the "Hea" wrapper
    'comment-wrapper-inner-start', // element-level before a comment its wrapper holds
    'target-start', // inside comment, before "di"
    'target-mid', // inside comment, "d|i"
    'target-end-text', // inside comment, "di|" (text-node level)
    'target-end-elem', // inside comment, after "di" before the body (element offset)
    'comment-trailing-edge', // inside comment, after the (display:none) body
    'comment-wrapper-inner-end', // element-level after a comment its wrapper holds
    'block-after-comment', // block level, right after </comment>
    'after-comment-inner-elem', // element-level at the start of the "ng" wrapper
    'after-comment-text', // "|ng" (text-node level, just after the comment)
    'ng-mid', // "n|g"
    'ng-end', // "ng|"
  ] as const;

  type Position = (typeof POSITIONS)[number];

  function positionsFor(fixture: Fixture): Position[] {
    const { beforeWrapper, afterWrapper, commentWrapper } = fixture;
    return POSITIONS.filter((where) => {
      // A wrapper that also holds the comment has no "inner edge beside the
      // comment" distinct from the comment-wrapper positions below.
      if (where === 'before-comment-inner-elem') {
        return beforeWrapper !== null && beforeWrapper !== commentWrapper;
      }
      if (where === 'after-comment-inner-elem') {
        return afterWrapper !== null && afterWrapper !== commentWrapper;
      }
      if (where === 'comment-wrapper-inner-start' || where === 'comment-wrapper-inner-end') {
        return commentWrapper !== null;
      }
      return true;
    });
  }

  // Character AND word granularity. Chromium's word deletion treats the text
  // around a comment as one word ("Hea" + "di" + "ng" = "Heading"), so an
  // unguarded Ctrl+Backspace in "ng" wipes the whole run — comment and body
  // included. Every position must survive both.
  const KEYS = ['Backspace', 'Delete', 'Control+Backspace', 'Control+Delete'] as const;

  async function placeCaret(page: Page, fixture: Fixture, where: Position): Promise<void> {
    await page.evaluate(
      ({ where, beforeWrapper, afterWrapper, commentWrapper }) => {
        const root = document.querySelector('#ahve-root')!;
        const h2 = root.querySelector('h2')!;
        const comment = root.querySelector('comment')!;
        const beforeHost = beforeWrapper ? root.querySelector(beforeWrapper)! : h2;
        const afterHost = afterWrapper ? root.querySelector(afterWrapper)! : h2;
        const commentHost = commentWrapper ? root.querySelector(commentWrapper)! : h2;
        // Resolved by content rather than by position: a wrapper may hold the
        // comment as well as its own text, so "the host's first child" is not
        // reliably the run, and a silently mis-resolved node would still pass
        // every assertion below.
        const textNamed = (data: string): Node => {
          const walker = document.createTreeWalker(h2, NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) {
            if (walker.currentNode.nodeValue === data) return walker.currentNode;
          }
          throw new Error(`text node not found: ${data}`);
        };
        const hea = textNamed('Hea');
        const di = comment.firstChild!; // text "di"
        const ng = textNamed('ng');
        const set = (node: Node, off: number): void => {
          const r = document.createRange();
          r.setStart(node, off);
          r.collapse(true);
          const s = window.getSelection()!;
          s.removeAllRanges();
          s.addRange(r);
        };
        const indexIn = (parent: Node, child: Node): number =>
          Array.prototype.indexOf.call(parent.childNodes, child);
        switch (where) {
          case 'hea-start': return set(hea, 0);
          case 'hea-mid': return set(hea, 2);
          case 'before-comment': return set(hea, 3);
          case 'before-comment-inner-elem':
            return set(beforeHost, beforeHost.childNodes.length);
          case 'comment-wrapper-inner-start': return set(commentHost, 0);
          case 'comment-wrapper-inner-end':
            return set(commentHost, commentHost.childNodes.length);
          case 'target-start': return set(di, 0);
          case 'target-mid': return set(di, 1);
          case 'target-end-text': return set(di, 2);
          case 'target-end-elem': return set(comment, 1);
          case 'comment-trailing-edge': return set(comment, comment.childNodes.length);
          case 'block-after-comment': return set(h2, indexIn(h2, comment) + 1);
          case 'after-comment-inner-elem': return set(afterHost, 0);
          case 'after-comment-text': return set(ng, 0);
          case 'ng-mid': return set(ng, 1);
          case 'ng-end': return set(ng, 2);
          default: {
            // A position added to POSITIONS without a case here would leave the
            // caret wherever focusEditor() put it, and every assertion below
            // would still pass — a silently unverified test in a 200-case
            // sweep. `never` catches it at compile time, the throw at runtime.
            const unhandled: never = where;
            throw new Error(`unhandled caret position: ${String(unhandled)}`);
          }
        }
      },
      {
        where,
        beforeWrapper: fixture.beforeWrapper,
        afterWrapper: fixture.afterWrapper,
        commentWrapper: fixture.commentWrapper,
      },
    );
  }

  for (const fixture of FIXTURES) {
    for (const where of positionsFor(fixture)) {
      for (const key of KEYS) {
        test(`[${fixture.name}] ${key} at ${where} keeps the comment and its body`, async ({ page }) => {
          await mountEditor(page, fixture.html);
          await focusEditor(page);
          await placeCaret(page, fixture, where);
          await page.keyboard.press(key);

          const comment = page.locator('#ahve-root comment');
          await expect(comment).toHaveCount(1);
          await expect(comment).toHaveAttribute('id', 'c-sweep01');
          // The body is never collateral-deleted.
          await expect(comment.locator('comment-body')).toHaveText('Comment');
          await expect(comment.locator('comment-body')).toHaveAttribute('data-author', 'human');
          // Comments never end up nested inside one another.
          await expect(page.locator('#ahve-root comment comment')).toHaveCount(0);
        });
      }
    }
  }
});

test.describe('Word deletion around comments', () => {
  // The state the sweep above deliberately does NOT assert about, followed to
  // its end. One Ctrl+Backspace inside the target removes the whole word, so
  // the annotation is left rendering as nothing — and serialize.ts never prunes
  // an empty <comment>, so if the story stopped there the user would be saving
  // an invisible element they can no longer click, select, or delete. The
  // second keystroke is what closes it.
  test('Ctrl+Backspace empties a comment target in one keystroke, and the next drops the comment', async ({ page }) => {
    await mountEditor(
      page,
      '<h2>Hea<comment id="c-empty01">di<comment-body>note</comment-body></comment>ng</h2>',
    );
    await focusEditor(page);
    await page.evaluate(() => {
      const target = document.querySelector('#ahve-root comment')!.firstChild!;
      const range = document.createRange();
      range.setStart(target, target.textContent!.length); // "di|"
      range.collapse(true);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });

    await page.keyboard.press('Control+Backspace');

    // Emptied, but still whole: the body is never collateral of this keystroke.
    const comment = page.locator('#ahve-root comment');
    await expect(comment).toHaveCount(1);
    expect(await comment.evaluate((node) => node.textContent)).toBe('note');
    expect(await page.locator('#ahve-root comment-body').evaluate((node) => node.textContent))
      .toBe('note');

    await page.keyboard.press('Control+Backspace');

    await expect(comment).toHaveCount(0);
    expect(await page.locator('#ahve-root h2').evaluate((node) => node.textContent))
      .toBe('Heang');
  });

  test('Ctrl+Backspace far after a comment deletes the previous word', async ({ page }) => {
    await mountEditor(
      page,
      '<p>See <comment id="c-word001">this<comment-body>note</comment-body></comment>' +
        ' for a longer explanation</p>',
    );
    await focusEditor(page);
    await page.evaluate(() => {
      const text = document.querySelector('#ahve-root comment')!.nextSibling!;
      const range = document.createRange();
      range.setStart(text, text.textContent!.length);
      range.collapse(true);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });

    await page.keyboard.press('Control+Backspace');

    const paragraphText = await page.locator('#ahve-root p').evaluate((node) => node.textContent);
    expect(paragraphText).toContain('for a longer');
    expect(paragraphText).not.toContain('explanation');
    await expect(page.locator('#ahve-root comment')).toHaveAttribute('id', 'c-word001');
    expect(await page.locator('#ahve-root comment-body').evaluate((node) => node.textContent))
      .toBe('note');
  });

  test('Ctrl+Delete far before a comment deletes the next word', async ({ page }) => {
    await mountEditor(
      page,
      '<p>explanation before <comment id="c-word003">this' +
        '<comment-body>note</comment-body></comment></p>',
    );
    await focusEditor(page);
    await page.evaluate(() => {
      const text = document.querySelector('#ahve-root p')!.firstChild!;
      const range = document.createRange();
      range.setStart(text, 0);
      range.collapse(true);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });

    await page.keyboard.press('Control+Delete');

    const paragraphText = await page.locator('#ahve-root p').evaluate((node) => node.textContent);
    expect(paragraphText).toContain('before');
    expect(paragraphText).not.toContain('explanation');
    await expect(page.locator('#ahve-root comment')).toHaveAttribute('id', 'c-word003');
    expect(await page.locator('#ahve-root comment-body').evaluate((node) => node.textContent))
      .toBe('note');
  });

  test('Ctrl+Backspace at a comment block boundary preserves its metadata', async ({ page }) => {
    await mountEditor(
      page,
      '<p>a<comment id="c-word002">t<comment-body>note</comment-body></comment></p>' +
        '<p>second</p>',
    );
    await focusEditor(page);
    await caretAtStart(page, '#ahve-root > p:last-child');

    await page.keyboard.press('Control+Backspace');

    await expect(page.locator('#ahve-root > p')).toHaveCount(1);
    await expect(page.locator('#ahve-root comment')).toHaveAttribute('id', 'c-word002');
    expect(await page.locator('#ahve-root comment-body').evaluate((node) => node.textContent))
      .toBe('note');
  });

  test('Ctrl+Delete at a comment block boundary preserves its metadata', async ({ page }) => {
    await mountEditor(
      page,
      '<p>first</p><p><comment id="c-word004">t' +
        '<comment-body>note</comment-body></comment>b</p>',
    );
    await focusEditor(page);
    await caretAtEnd(page, '#ahve-root > p:first-child');

    await page.keyboard.press('Control+Delete');

    await expect(page.locator('#ahve-root > p')).toHaveCount(1);
    await expect(page.locator('#ahve-root comment')).toHaveAttribute('id', 'c-word004');
    expect(await page.locator('#ahve-root comment-body').evaluate((node) => node.textContent))
      .toBe('note');
  });

  // A comment several words away from the join is still at risk: Chromium's own
  // deleteWordForward reaches into the next block and strips <comment-body>.
  // These two lock in that the safe merge covers the whole block, not just the
  // join — the jsdom tests cannot show it because they have no browser default.
  test('Ctrl+Backspace at a block boundary keeps a comment away from the join intact', async ({ page }) => {
    await mountEditor(
      page,
      '<p>Note <comment id="c-word005">x<comment-body>note</comment-body></comment>' +
        ' and a long tail of words</p><p>second</p>',
    );
    await focusEditor(page);
    await caretAtStart(page, '#ahve-root > p:last-child');

    await page.keyboard.press('Control+Backspace');

    await expect(page.locator('#ahve-root > p')).toHaveCount(1);
    await expect(page.locator('#ahve-root comment')).toHaveAttribute('id', 'c-word005');
    expect(await page.locator('#ahve-root comment-body').evaluate((node) => node.textContent))
      .toBe('note');
    const text = await page.locator('#ahve-root p').evaluate((node) => node.textContent);
    expect(text).toContain('and a long tail of words');
  });

  test('Ctrl+Delete at a block boundary keeps a comment away from the join intact', async ({ page }) => {
    await mountEditor(
      page,
      '<p>first</p><p>words before <comment id="c-word006">x' +
        '<comment-body>note</comment-body></comment> and a long tail</p>',
    );
    await focusEditor(page);
    await caretAtEnd(page, '#ahve-root > p:first-child');

    await page.keyboard.press('Control+Delete');

    await expect(page.locator('#ahve-root > p')).toHaveCount(1);
    await expect(page.locator('#ahve-root comment')).toHaveAttribute('id', 'c-word006');
    expect(await page.locator('#ahve-root comment-body').evaluate((node) => node.textContent))
      .toBe('note');
    const text = await page.locator('#ahve-root p').evaluate((node) => node.textContent);
    expect(text).toContain('words before');
  });

  // An inline wrapper between the caret and the comment changes nothing for
  // Chromium — "Hea"+"di"+"ng" is still one word — so the guard must reach
  // through <strong>/<em> as well, not just look at sibling nodes.
  test('Ctrl+Backspace in bold text right after a comment keeps the comment', async ({ page }) => {
    await mountEditor(
      page,
      '<h2>Hea<comment id="c-word007">di<comment-body>note</comment-body></comment>' +
        '<strong>ng</strong></h2>',
    );
    await focusEditor(page);
    await page.evaluate(() => {
      const text = document.querySelector('#ahve-root strong')!.firstChild!;
      const range = document.createRange();
      range.setStart(text, 1); // "n|g"
      range.collapse(true);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });

    await page.keyboard.press('Control+Backspace');

    await expect(page.locator('#ahve-root comment')).toHaveAttribute('id', 'c-word007');
    expect(await page.locator('#ahve-root comment-body').evaluate((node) => node.textContent))
      .toBe('note');
    expect(await page.locator('#ahve-root strong').evaluate((node) => node.textContent))
      .toBe('g');
  });

  // The wrapper may also sit BETWEEN the caret and the comment. There is still
  // no word boundary in "Hea"+"di"+"n"+"g", so the guard must reach the comment
  // through a sibling wrapper as well as out of an enclosing one.
  test('Ctrl+Backspace after a wrapper separating it from a comment keeps the comment', async ({ page }) => {
    await mountEditor(
      page,
      '<h2>Hea<comment id="c-word009">di<comment-body>note</comment-body></comment>' +
        '<strong>n</strong>g</h2>',
    );
    await focusEditor(page);
    await page.evaluate(() => {
      const text = document.querySelector('#ahve-root h2')!.lastChild!;
      const range = document.createRange();
      range.setStart(text, 1); // "g|"
      range.collapse(true);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });

    await page.keyboard.press('Control+Backspace');

    await expect(page.locator('#ahve-root comment')).toHaveAttribute('id', 'c-word009');
    expect(await page.locator('#ahve-root comment-body').evaluate((node) => node.textContent))
      .toBe('note');
    expect(await page.locator('#ahve-root strong').evaluate((node) => node.textContent))
      .toBe('n');
  });

  test('Ctrl+Delete in italic text right before a comment keeps the comment', async ({ page }) => {
    await mountEditor(
      page,
      '<h2><em>Hea</em><comment id="c-word008">di<comment-body>note</comment-body>' +
        '</comment>ng</h2>',
    );
    await focusEditor(page);
    await caretAtStart(page, '#ahve-root em');

    await page.keyboard.press('Control+Delete');

    await expect(page.locator('#ahve-root comment')).toHaveAttribute('id', 'c-word008');
    expect(await page.locator('#ahve-root comment-body').evaluate((node) => node.textContent))
      .toBe('note');
    expect(await page.locator('#ahve-root em').evaluate((node) => node.textContent))
      .toBe(''); // "Hea" removed, the comment ahead of it untouched
  });

  // The wrapper an allow list is most likely to miss. Nothing in this editor
  // emits <font>, but renderer.ts sanitizes with a deny list, so a .html file
  // opened from disk carries it into the editor unchanged — and the native
  // probe below shows Chromium eating the comment through it.
  test('Ctrl+Backspace in an imported <font> right after a comment keeps the comment', async ({ page }) => {
    await mountEditor(
      page,
      '<h2>Hea<comment id="c-word010">di<comment-body>note</comment-body></comment>' +
        '<font color="red">ng</font></h2>',
    );
    await focusEditor(page);
    await page.evaluate(() => {
      const text = document.querySelector('#ahve-root font')!.firstChild!;
      const range = document.createRange();
      range.setStart(text, 1); // "n|g"
      range.collapse(true);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });

    await page.keyboard.press('Control+Backspace');

    await expect(page.locator('#ahve-root comment')).toHaveAttribute('id', 'c-word010');
    expect(await page.locator('#ahve-root comment-body').evaluate((node) => node.textContent))
      .toBe('note');
    expect(await page.locator('#ahve-root font').evaluate((node) => node.textContent))
      .toBe('g');
  });

  // An <svg> is foreign content: its tagName and those of its children are
  // lowercase, so the uppercase stop list cannot name them and the inline-flow
  // scan would read straight into the graphic, find the comment beyond it, and
  // "delete a character" out of the SVG's own text. Whatever Chromium does with
  // the keystroke, the one outcome that must never happen is the graphic coming
  // back partially eaten.
  test('Backspace after an imported <svg> never truncates the graphic text', async ({ page }) => {
    await mountEditor(
      page,
      '<p><comment id="c-svg0001">x<comment-body>note</comment-body></comment>' +
        '<svg><text>abc</text></svg>d</p>',
    );
    await focusEditor(page);
    await page.evaluate(() => {
      const tail = document.querySelector('#ahve-root p')!.lastChild!; // text "d"
      const range = document.createRange();
      range.setStart(tail, 0); // "|d"
      range.collapse(true);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });

    await page.keyboard.press('Backspace');

    const svgText = await page
      .locator('#ahve-root svg')
      .evaluateAll((nodes) => nodes.map((node) => node.textContent));
    // Either Chromium removed the whole graphic (a deletion the user can see)
    // or it is untouched — never "ab".
    expect(svgText).toEqual(svgText.length === 0 ? [] : ['abc']);
    expect(await page.locator('#ahve-root comment-body').evaluate((n) => n.textContent))
      .toBe('note');
  });

  // The wrapper between the caret and the comment may hold nothing at all —
  // the shape left the moment the last character inside a <strong> is deleted,
  // and the one handleFormattedEnter builds on purpose. It paints nothing, so
  // Chromium reads straight past it to the comment; resolving the caret onto it
  // and stopping there hands the keystroke back to that destructive default.
  test('Ctrl+Backspace after an empty wrapper next to a comment keeps the comment', async ({ page }) => {
    await mountEditor(
      page,
      '<p><comment id="c-empt001">ab<comment-body>note</comment-body></comment>' +
        '<strong></strong>c</p>',
    );
    await focusEditor(page);
    await page.evaluate(() => {
      const text = document.querySelector('#ahve-root p')!.lastChild!;
      const range = document.createRange();
      range.setStart(text, 0); // "|c"
      range.collapse(true);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });

    await page.keyboard.press('Control+Backspace');

    await expect(page.locator('#ahve-root comment')).toHaveAttribute('id', 'c-empt001');
    expect(await page.locator('#ahve-root comment-body').evaluate((node) => node.textContent))
      .toBe('note');
    // One character off the target, not the whole annotated word.
    expect(await page.locator('#ahve-root comment').evaluate((node) => node.firstChild!.textContent))
      .toBe('a');
  });

  test('Backspace after an empty wrapper next to a comment keeps the comment', async ({ page }) => {
    await mountEditor(
      page,
      '<p><comment id="c-empt003">ab<comment-body>note</comment-body></comment>' +
        '<strong></strong>c</p>',
    );
    await focusEditor(page);
    await page.evaluate(() => {
      const text = document.querySelector('#ahve-root p')!.lastChild!;
      const range = document.createRange();
      range.setStart(text, 0);
      range.collapse(true);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });

    await page.keyboard.press('Backspace');

    await expect(page.locator('#ahve-root comment')).toHaveAttribute('id', 'c-empt003');
    expect(await page.locator('#ahve-root comment-body').evaluate((node) => node.textContent))
      .toBe('note');
    expect(await page.locator('#ahve-root comment').evaluate((node) => node.firstChild!.textContent))
      .toBe('a');
  });

  test('Ctrl+Delete before an empty wrapper next to a comment keeps the comment', async ({ page }) => {
    await mountEditor(
      page,
      '<p>c<strong></strong><comment id="c-empt002">ab' +
        '<comment-body>note</comment-body></comment></p>',
    );
    await focusEditor(page);
    await page.evaluate(() => {
      const text = document.querySelector('#ahve-root p')!.firstChild!;
      const range = document.createRange();
      range.setStart(text, 1); // "c|"
      range.collapse(true);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });

    await page.keyboard.press('Control+Delete');

    await expect(page.locator('#ahve-root comment')).toHaveAttribute('id', 'c-empt002');
    expect(await page.locator('#ahve-root comment-body').evaluate((node) => node.textContent))
      .toBe('note');
    expect(await page.locator('#ahve-root comment').evaluate((node) => node.firstChild!.textContent))
      .toBe('b');
  });

  // The safe merge needs BOTH sides to be mergeable leaf blocks, so a list or
  // a nested quote next to the join leaves the keystroke to Chromium.
  //
  // The forward case below is the measured one: removing the guard and running
  // it against #ahve-root leaves the <comment> element in place but WITHOUT its
  // <comment-body> — the word range crosses the block boundary and takes the
  // display:none, contenteditable=false metadata with it. (That measurement has
  // to happen here rather than on a native probe, where the metadata renders as
  // ordinary text and stops the merge; see the note in the probe suite below.)
  //
  // Chromium's backward word deletion happens to be non-destructive at the same
  // joins today, so the Ctrl+Backspace cases pin down the deliberate symmetry
  // rather than a measured hazard: the guard blocks both directions because the
  // browser's range is resolved from layout this editor cannot reproduce, and
  // one direction quietly changing is not something a user should discover by
  // losing an annotation.
  test('Ctrl+Backspace at a join with a commented list keeps the comment', async ({ page }) => {
    const html =
      '<ul><li>Note <comment id="c-join001">x<comment-body>note</comment-body></comment>' +
      ' and a long tail of words</li></ul><p>second</p>';
    await mountEditor(page, html);
    await focusEditor(page);
    await caretAtStart(page, '#ahve-root > p');

    await page.keyboard.press('Control+Backspace');

    await expect(page.locator('#ahve-root comment')).toHaveAttribute('id', 'c-join001');
    expect(await page.locator('#ahve-root comment-body').evaluate((node) => node.textContent))
      .toBe('note');
    expect(await page.locator('#ahve-root li').evaluate((node) => node.textContent))
      .toContain('and a long tail of words');
  });

  test('Ctrl+Delete at a join with a commented list keeps the comment', async ({ page }) => {
    const html =
      '<p>first</p><ul><li>Note <comment id="c-join002">x' +
      '<comment-body>note</comment-body></comment> and a long tail of words</li></ul>';
    await mountEditor(page, html);
    await focusEditor(page);
    await caretAtEnd(page, '#ahve-root > p');

    await page.keyboard.press('Control+Delete');

    await expect(page.locator('#ahve-root comment')).toHaveAttribute('id', 'c-join002');
    expect(await page.locator('#ahve-root comment-body').evaluate((node) => node.textContent))
      .toBe('note');
    expect(await page.locator('#ahve-root li').evaluate((node) => node.textContent))
      .toContain('and a long tail of words');
  });

  // The character-granularity leg of the same guard, and the reason the guard
  // carries no granularity condition at all. "A character deletion only acts on
  // what is immediately beside the caret" stops being true once the thing beside
  // the caret is a block boundary: the browser resolves its range from layout,
  // and the forward case below was measured reaching the display:none,
  // contenteditable=false metadata in the next block and stripping it. A jsdom
  // test could only ever show that we did not preventDefault(), never what
  // Chromium then does, so these two have to run in a real browser.
  test('Backspace at a join with a commented list keeps the comment', async ({ page }) => {
    const html =
      '<ul><li>Note <comment id="c-char001">x<comment-body>note</comment-body></comment>' +
      ' and a long tail of words</li></ul><p>second</p>';
    await mountEditor(page, html);
    await focusEditor(page);
    await caretAtStart(page, '#ahve-root > p');

    await page.keyboard.press('Backspace');

    await expect(page.locator('#ahve-root comment')).toHaveAttribute('id', 'c-char001');
    expect(await page.locator('#ahve-root comment-body').evaluate((node) => node.textContent))
      .toBe('note');
    expect(await page.locator('#ahve-root comment').evaluate((node) => node.firstChild!.textContent))
      .toBe('x');
  });

  test('Delete at a join with a commented list keeps the comment', async ({ page }) => {
    const html =
      '<p>first</p><ul><li>Note <comment id="c-char002">x' +
      '<comment-body>note</comment-body></comment> and a long tail of words</li></ul>';
    await mountEditor(page, html);
    await focusEditor(page);
    await caretAtEnd(page, '#ahve-root > p');

    await page.keyboard.press('Delete');

    await expect(page.locator('#ahve-root comment')).toHaveAttribute('id', 'c-char002');
    expect(await page.locator('#ahve-root comment-body').evaluate((node) => node.textContent))
      .toBe('note');
    expect(await page.locator('#ahve-root comment').evaluate((node) => node.firstChild!.textContent))
      .toBe('x');
  });

  // A <comment> whose OWN container holds a block: the caret's line ends at that
  // block while the container goes on, so there is no next visible character for
  // this keystroke and no merge handler owns the shape. The keystroke has to be
  // consumed — reading through the block deletes a character out of a paragraph
  // the caret was never in, and declining hands it to the browser default with
  // the caret pressed against the contenteditable=false metadata.
  test('Delete at a comment trailing edge never reaches into a sibling block', async ({ page }) => {
    const html =
      '<blockquote><comment id="c-sib001">note' +
      '<comment-body>body</comment-body></comment><p>tail</p></blockquote>';
    await mountEditor(page, html);
    await focusEditor(page);
    await page.evaluate(() => {
      const target = document.querySelector('#ahve-root comment')!.firstChild!;
      const range = document.createRange();
      range.setStart(target, target.textContent!.length);
      range.collapse(true);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });

    await page.keyboard.press('Delete');

    expect(await page.locator('#ahve-root blockquote > p').evaluate((node) => node.textContent))
      .toBe('tail');
    expect(await page.locator('#ahve-root comment-body').evaluate((node) => node.textContent))
      .toBe('body');
    expect(await page.locator('#ahve-root comment').evaluate((node) => node.firstChild!.textContent))
      .toBe('note');
  });

  // The leading-edge mirror of the test above, and the shape that guard was
  // missing: the block sits BEFORE the comment in the same container, so the
  // caret's line begins at the comment while the container goes on. Nothing
  // inline precedes the caret, the enclosing <blockquote> is not at its own
  // start (the <p> is in the way), and no merge handler owns a comment that is
  // not a block — so before blockedBeforeComment existed every guard declined.
  //
  // Measured with the guard removed: the plain Backspace below leaves
  // <p>tailnote</p> — the target text merged into the previous paragraph as
  // bare text, the <comment> and its body gone — and the Ctrl+Backspace one
  // removes the previous paragraph outright. A single keystroke, one lost
  // annotation.
  test('Backspace at a comment leading edge never reaches into a sibling block', async ({ page }) => {
    const html =
      '<blockquote><p>tail</p><comment id="c-sib002">note' +
      '<comment-body>body</comment-body></comment></blockquote>';
    await mountEditor(page, html);
    await focusEditor(page);
    await page.evaluate(() => {
      const target = document.querySelector('#ahve-root comment')!.firstChild!;
      const range = document.createRange();
      range.setStart(target, 0);
      range.collapse(true);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });

    await page.keyboard.press('Backspace');

    expect(await page.locator('#ahve-root blockquote > p').evaluate((node) => node.textContent))
      .toBe('tail');
    expect(await page.locator('#ahve-root comment-body').evaluate((node) => node.textContent))
      .toBe('body');
    expect(await page.locator('#ahve-root comment').evaluate((node) => node.firstChild!.textContent))
      .toBe('note');
  });

  // The same leading edge with a word deletion, which reaches further: the
  // guard must not depend on granularity any more than its trailing-edge twin
  // does.
  test('Ctrl+Backspace at a comment leading edge never reaches into a sibling block', async ({ page }) => {
    const html =
      '<div><p>a long tail of words</p><comment id="c-sib003">note' +
      '<comment-body>body</comment-body></comment></div>';
    await mountEditor(page, html);
    await focusEditor(page);
    await caretAtStart(page, '#ahve-root comment');

    await page.keyboard.press('Control+Backspace');

    expect(await page.locator('#ahve-root div > p').evaluate((node) => node.textContent))
      .toBe('a long tail of words');
    expect(await page.locator('#ahve-root comment-body').evaluate((node) => node.textContent))
      .toBe('body');
  });

  // The caret's own block is the one that cannot merge here: an <li> never
  // does, so the join is only found by climbing out of the list.
  test('Ctrl+Backspace from a first list item keeps a commented paragraph', async ({ page }) => {
    const html =
      '<p>Note <comment id="c-join003">x<comment-body>note</comment-body></comment>' +
      ' and a long tail of words</p><ul><li>item</li></ul>';
    await mountEditor(page, html);
    await focusEditor(page);
    await caretAtStart(page, '#ahve-root li');

    await page.keyboard.press('Control+Backspace');

    await expect(page.locator('#ahve-root comment')).toHaveAttribute('id', 'c-join003');
    expect(await page.locator('#ahve-root comment-body').evaluate((node) => node.textContent))
      .toBe('note');
    expect(await page.locator('#ahve-root p').evaluate((node) => node.textContent))
      .toContain('and a long tail of words');
  });

  // The same join with the caret in a bare inline run. renderer.ts installs
  // body content verbatim, so a .html file from disk can put text straight
  // beside a list — and then there is no block ancestor for the boundary test
  // to ask about. The structural guard covers this shape in
  // tests/e2e/structural-boundaries.spec.ts; this is its comment-side mirror.
  test('Ctrl+Delete from bare root text into a commented list keeps the comment', async ({ page }) => {
    const html =
      'text<ul><li>Note <comment id="c-join004">x<comment-body>note</comment-body></comment>' +
      ' and a long tail of words</li></ul>';
    await mountEditor(page, html);
    await focusEditor(page);
    await page.evaluate(() => {
      const text = document.querySelector('#ahve-root')!.firstChild!;
      const range = document.createRange();
      range.setStart(text, text.textContent!.length);
      range.collapse(true);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });

    await page.keyboard.press('Control+Delete');

    await expect(page.locator('#ahve-root comment')).toHaveAttribute('id', 'c-join004');
    expect(await page.locator('#ahve-root comment-body').evaluate((node) => node.textContent))
      .toBe('note');
    expect(await page.locator('#ahve-root li').evaluate((node) => node.textContent))
      .toContain('and a long tail of words');
  });

  // Our own merge at a comment-free join: identical to what Chromium does there
  // (see the native probe below), so routing word/line deletion through it
  // costs the user nothing.
  test('Ctrl+Delete at a comment-free block boundary merges without deleting a word', async ({ page }) => {
    await mountEditor(page, '<p>first</p><p>words before a long tail</p>');
    await focusEditor(page);
    await caretAtEnd(page, '#ahve-root > p:first-child');

    await page.keyboard.press('Control+Delete');

    await expect(page.locator('#ahve-root > p')).toHaveCount(1);
    expect(await page.locator('#ahve-root p').evaluate((node) => node.textContent))
      .toBe('firstwords before a long tail');
  });

  test('Ctrl+Backspace at a comment-free block boundary merges without deleting a word', async ({ page }) => {
    await mountEditor(page, '<p>a long tail of words</p><p>second</p>');
    await focusEditor(page);
    await caretAtStart(page, '#ahve-root > p:last-child');

    await page.keyboard.press('Control+Backspace');

    await expect(page.locator('#ahve-root > p')).toHaveCount(1);
    expect(await page.locator('#ahve-root p').evaluate((node) => node.textContent))
      .toBe('a long tail of wordssecond');
  });
});

// Two Chromium behaviors the deletion design is built on. Neither can be
// asserted against #ahve-root — a handler preventDefault()s first, so such a
// test would only ever restate our own replacement behavior. They are measured
// here on a bare contenteditable the editor never binds to, so this suite fails
// loudly if a future Chromium moves the ground the design stands on.
test.describe('Chromium deletion defaults (native probe)', () => {
  test('Ctrl+Backspace at a block start merges without deleting the previous word', async ({ page }) => {
    await mountNativeProbe(page, '<p>a long tail of words</p><p>second</p>');
    await caretAtStart(page, `${NATIVE_PROBE} > p:last-child`);

    await page.keyboard.press('Control+Backspace');

    // No word is lost, so taking over the merge costs no native granularity.
    expect(await getNativeProbeHtml(page)).toBe('<p>a long tail of wordssecond</p>');
  });

  test('Ctrl+Delete at a block end merges without deleting the next word', async ({ page }) => {
    await mountNativeProbe(page, '<p>first</p><p>words before a long tail</p>');
    await caretAtEnd(page, `${NATIVE_PROBE} > p:first-child`);

    await page.keyboard.press('Control+Delete');

    expect(await getNativeProbeHtml(page)).toBe('<p>firstwords before a long tail</p>');
  });

  test('Ctrl+Backspace mid-word after a comment destroys the comment and its body', async ({ page }) => {
    await mountNativeProbe(
      page,
      '<p>Hea<comment id="c1">di' +
        '<comment-body contenteditable="false">Note</comment-body></comment>ng</p>',
    );
    await page.evaluate((probe) => {
      const text = document.querySelector(`${probe} p`)!.lastChild!;
      const range = document.createRange();
      range.setStart(text, 1); // "n|g"
      range.collapse(true);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    }, NATIVE_PROBE);

    await page.keyboard.press('Control+Backspace');

    // "Hea" + "di" + "ng" is one word to Chromium, so the whole run goes —
    // comment element and contenteditable=false body included. This is the
    // hazard nativeDeletionStaysClearOfComment() exists to keep away from.
    expect(await getNativeProbeHtml(page)).toBe('<p>g</p>');
  });

  // NOTE — there is deliberately no probe here for the block join the safe
  // merge declines (a list or a nested quote beside the caret). A probe cannot
  // measure it: comment-body is only display:none under #ahve-root, and with
  // the metadata rendered it becomes content that stops the merge, so the probe
  // reports SAFE where the real editor is destructive — the exact trap
  // mountNativeProbe's own doc warns about. That default was measured the way
  // the doc prescribes instead, against #ahve-root with the guard removed; see
  // the Ctrl+Delete test in "Word deletion around comments" above.

  // An inline wrapper does not make the run two words, which is why the danger
  // zone is resolved through wrappers rather than by sibling nodes.
  test('Ctrl+Backspace mid-word after a wrapped comment destroys it too', async ({ page }) => {
    await mountNativeProbe(
      page,
      '<p>Hea<comment id="c1">di' +
        '<comment-body contenteditable="false">Note</comment-body></comment>' +
        '<strong>ng</strong></p>',
    );
    await page.evaluate((probe) => {
      const text = document.querySelector(`${probe} strong`)!.firstChild!;
      const range = document.createRange();
      range.setStart(text, 1); // "n|g"
      range.collapse(true);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    }, NATIVE_PROBE);

    await page.keyboard.press('Control+Backspace');

    const html = await getNativeProbeHtml(page);
    expect(html).not.toContain('comment-body');
    expect(html).not.toContain('<comment');
  });

  // The caret at a wrapper's INNER edge is the position a sibling-only lookup
  // cannot see: the wrapper's child list holds nothing beside the caret, so
  // resolving the deletion target has to step out of the wrapper. These two pin
  // down that the browser default there is destructive, which is the whole
  // reason adjacentNodeInInlineFlow() follows the inline flow.
  test('Ctrl+Backspace at the inner start of a wrapper destroys the comment before it', async ({ page }) => {
    await mountNativeProbe(
      page,
      '<p>Hea<comment id="c1">di' +
        '<comment-body contenteditable="false">Note</comment-body></comment>' +
        '<strong>ng</strong></p>',
    );
    await caretAtStart(page, `${NATIVE_PROBE} strong`);

    await page.keyboard.press('Control+Backspace');

    // "Hea", the comment, and its contenteditable=false body all go.
    expect(await getNativeProbeHtml(page)).toBe('<p><strong>ng</strong></p>');
  });

  test('Ctrl+Delete at the inner end of a wrapper destroys the comment after it', async ({ page }) => {
    await mountNativeProbe(
      page,
      '<p><em>Hea</em><comment id="c1">di' +
        '<comment-body contenteditable="false">Note</comment-body></comment>ng</p>',
    );
    await caretAtEnd(page, `${NATIVE_PROBE} em`);

    await page.keyboard.press('Control+Delete');

    expect(await getNativeProbeHtml(page)).toBe('<p><em>Hea</em></p>');
  });

  // The wrapper set cannot be limited to the formats this editor's toolbar
  // emits: an imported/pasted <u> is no word boundary either. <font> is the
  // case an allow list is most likely to miss — nothing in this editor emits
  // it, yet renderer.ts sanitizes with a deny list so a .html file from disk
  // carries it straight through, and paste-sanitize keeps it whenever it still
  // has an attribute. Chromium reads through both identically.
  for (const tag of ['u', 'font'] as const) {
    test(`Ctrl+Backspace mid-word after a comment wrapped in an imported <${tag}> destroys it`, async ({ page }) => {
      await mountNativeProbe(
        page,
        '<p>Hea<comment id="c1">di' +
          '<comment-body contenteditable="false">Note</comment-body></comment>' +
          `<${tag} color="red">ng</${tag}></p>`,
      );
      await page.evaluate(
        ({ probe, tag }) => {
          const text = document.querySelector(`${probe} ${tag}`)!.firstChild!;
          const range = document.createRange();
          range.setStart(text, 1); // "n|g"
          range.collapse(true);
          const selection = window.getSelection()!;
          selection.removeAllRanges();
          selection.addRange(range);
        },
        { probe: NATIVE_PROBE, tag },
      );

      await page.keyboard.press('Control+Backspace');

      const html = await getNativeProbeHtml(page);
      expect(html).not.toContain('comment-body');
      expect(html).not.toContain('<comment');
      expect(html).not.toContain('Hea');
    });
  }

  // Line granularity (deleteSoftLine* / deleteHardLine*) is the one entry in
  // DELETE_INPUT_TYPES with no probe above it, and this test is why.
  //
  // Chromium resolves a key chord to an editing command through per-platform
  // key bindings, and the line-deletion commands are bound only on macOS
  // (Cmd+Backspace / Cmd+Delete). Every chord that could plausibly reach them
  // elsewhere was measured here and none does — Control+u is Chromium's
  // built-in underline, the rest produce no beforeinput at all — so on the
  // platforms this suite runs on there is no keystroke that can drive the line
  // path through a real browser. Its coverage is therefore the synthetic
  // dispatch in tests/unit/editor-core.test.ts, and the assumption that a line
  // deletion at a block edge behaves like the word deletion probed above is
  // reasoned from the word result rather than measured.
  //
  // This test locks that limitation in place rather than leaving it implicit:
  // the day a Chromium or Playwright update starts mapping one of these chords,
  // it fails and says that the unit-level coverage can be upgraded to a real
  // probe of the kind used for Ctrl+Backspace.
  test('no chord on this platform drives a line deletion, so the unit tests own it', async ({ page }) => {
    // A canary whose only assertion is "nothing was seen" passes just as
    // happily when nothing CAN be seen — a broken listener in
    // recordProbeInputTypes, or keystrokes no longer reaching the probe, would
    // retire the canary in silence. Backspace always produces
    // deleteContentBackward, so this measures the measurement first.
    await mountNativeProbe(page, '<p>a long tail of words</p><p>second</p>');
    const control = await recordProbeInputTypes(page, async () => {
      await caretAtEnd(page, `${NATIVE_PROBE} > p:last-child`);
      await page.keyboard.press('Backspace');
    });
    expect(control).toContain('deleteContentBackward');

    const chords = [
      'Meta+Backspace',
      'Meta+Delete',
      'Control+u',
      'Control+k',
      'Shift+Delete',
      'Alt+Backspace',
    ];
    const lineDeletions: Record<string, string[]> = {};

    for (const chord of chords) {
      await mountNativeProbe(page, '<p>a long tail of words</p><p>second</p>');
      const seen = await recordProbeInputTypes(page, async () => {
        await caretAtStart(page, `${NATIVE_PROBE} > p:last-child`);
        await page.keyboard.press(chord);
      });
      const lines = seen.filter((type) => /^delete(Soft|Hard)Line/.test(type));
      if (lines.length > 0) lineDeletions[chord] = lines;
    }

    expect(lineDeletions).toEqual({});
  });
});
