import { expect, test } from '@playwright/test';
import {
  NATIVE_PROBE,
  caretAtEnd,
  caretAtStart,
  focusEditor,
  getNativeProbeHtml,
  getRootHtml,
  mountEditor,
  mountNativeProbe,
} from './helpers/page';

test.describe('Structural block deletion boundaries', () => {
  test('Backspace after a pre block preserves its code structure', async ({ page }) => {
    const html = '<pre><code>code</code></pre><p>para</p>';
    await mountEditor(page, html);
    await focusEditor(page);
    await caretAtStart(page, '#ahve-root > p');

    await page.keyboard.press('Backspace');

    expect(await getRootHtml(page)).toBe(html);
  });

  test('Delete removes hr between a paragraph and pre', async ({ page }) => {
    await mountEditor(page, '<p>lead</p><hr><pre><code>code</code></pre>');
    await focusEditor(page);
    await caretAtEnd(page, '#ahve-root p');

    await page.keyboard.press('Delete');

    expect(await getRootHtml(page)).toBe('<p>lead</p><pre><code>code</code></pre>');
  });

  test('Backspace removes hr between pre and a paragraph', async ({ page }) => {
    await mountEditor(page, '<pre><code>code</code></pre><hr><p>tail</p>');
    await focusEditor(page);
    await caretAtStart(page, '#ahve-root p');

    await page.keyboard.press('Backspace');

    expect(await getRootHtml(page)).toBe('<pre><code>code</code></pre><p>tail</p>');
  });

  test('Ctrl+Backspace at the start of summary preserves the details body', async ({ page }) => {
    const html =
      '<p>lead</p><details open=""><summary>Title</summary>' +
      '<p>Hidden body</p></details>';
    await mountEditor(page, html);
    await focusEditor(page);
    await caretAtStart(page, '#ahve-root summary');

    await page.keyboard.press('Control+Backspace');

    expect(await getRootHtml(page)).toBe(html);
  });

  test('Backspace removes an empty paragraph immediately after pre', async ({ page }) => {
    await mountEditor(page, '<pre><code>code</code></pre><p><br></p>');
    await focusEditor(page);
    await caretAtStart(page, '#ahve-root > p');

    await page.keyboard.press('Backspace');
    await page.keyboard.type('x');

    expect(await getRootHtml(page)).toBe('<pre><code>codex</code></pre>');
  });

  test('Delete removes an empty paragraph before pre and types at code start', async ({ page }) => {
    await mountEditor(page, '<p><br></p><pre><code>code</code></pre>');
    await focusEditor(page);
    await caretAtStart(page, '#ahve-root > p');

    await page.keyboard.press('Delete');
    await page.keyboard.type('x');

    expect(await getRootHtml(page)).toBe('<pre><code>xcode</code></pre>');
  });

  test('Backspace at pre start removes a preceding empty paragraph and types at code start', async ({ page }) => {
    await mountEditor(page, '<p><br></p><pre><code>code</code></pre>');
    await focusEditor(page);
    await caretAtStart(page, '#ahve-root code');

    await page.keyboard.press('Backspace');
    await page.keyboard.type('x');

    expect(await getRootHtml(page)).toBe('<pre><code>xcode</code></pre>');
  });

  test('Backspace removes an empty paragraph immediately after details', async ({ page }) => {
    await mountEditor(
      page,
      '<details open=""><summary>Title</summary><p>body</p></details><p><br></p>',
    );
    await focusEditor(page);
    await caretAtStart(page, '#ahve-root > p');

    await page.keyboard.press('Backspace');
    await page.keyboard.type('x');

    expect(await getRootHtml(page)).toBe(
      '<details open=""><summary>Title</summary><p>bodyx</p></details>',
    );
  });

  // A CLOSED details renders only its summary — the body is inside the UA
  // shadow tree and paints nothing. Placing the caret there would leave the user
  // typing into something they cannot see, which no jsdom test can catch: it has
  // no details rendering, so the unit test can only assert which node the caret
  // anchored to. Typing is what proves the caret landed somewhere visible.
  test('Backspace after a closed details types into the summary, not the hidden body', async ({ page }) => {
    await mountEditor(
      page,
      '<details><summary>Title</summary><p>body</p></details><p><br></p>',
    );
    await focusEditor(page);
    await caretAtStart(page, '#ahve-root > p:last-child');

    await page.keyboard.press('Backspace');
    await page.keyboard.type('x');

    expect(await getRootHtml(page)).toBe(
      '<details><summary>Titlex</summary><p>body</p></details>',
    );
  });

  // The nested mirror of the test above. jsdom can only assert which node the
  // caret anchored to; typing is what proves the landing spot is actually
  // painted, and a nested collapsed details is exactly where a one-level
  // hand-over drops the caret into content the reader cannot see.
  test('Backspace after nested closed details types into its summary, not the hidden body', async ({ page }) => {
    await mountEditor(
      page,
      '<details open=""><summary>Outer</summary>' +
        '<details><summary>Inner</summary><p>body</p></details>' +
        '</details><p><br></p>',
    );
    await focusEditor(page);
    await caretAtStart(page, '#ahve-root > p:last-child');

    await page.keyboard.press('Backspace');
    await page.keyboard.type('x');

    expect(await getRootHtml(page)).toBe(
      '<details open=""><summary>Outer</summary>' +
        '<details><summary>Innerx</summary><p>body</p></details>' +
        '</details>',
    );
  });

  // The same failure one wrapper further out. The hand-over walk stops
  // descending at the first target that is neither <pre> nor <details>, so ONE
  // ordinary container between the body and a nested collapsed details puts the
  // hidden text back within reach — and only typing shows it, because the caret
  // anchors on a perfectly ordinary text node either way.
  test('Backspace after details wrapping a closed details in a div types into the inner summary', async ({ page }) => {
    await mountEditor(
      page,
      '<details open=""><summary>Outer</summary>' +
        '<div><details><summary>Inner</summary><p>body</p></details></div>' +
        '</details><p><br></p>',
    );
    await focusEditor(page);
    await caretAtStart(page, '#ahve-root > p:last-child');

    await page.keyboard.press('Backspace');
    await page.keyboard.type('x');

    expect(await getRootHtml(page)).toBe(
      '<details open=""><summary>Outer</summary>' +
        '<div><details><summary>Innerx</summary><p>body</p></details></div>' +
        '</details>',
    );
  });

  test('Backspace after details whose list holds a closed details types into the inner summary', async ({ page }) => {
    await mountEditor(
      page,
      '<details open=""><summary>Outer</summary>' +
        '<ul><li><details><summary>Inner</summary><p>body</p></details></li></ul>' +
        '</details><p><br></p>',
    );
    await focusEditor(page);
    await caretAtStart(page, '#ahve-root > p:last-child');

    await page.keyboard.press('Backspace');
    await page.keyboard.type('x');

    expect(await getRootHtml(page)).toBe(
      '<details open=""><summary>Outer</summary>' +
        '<ul><li><details><summary>Innerx</summary><p>body</p></details></li></ul>' +
        '</details>',
    );
  });

  // A contenteditable=false body accepts a caret but not a character, so
  // landing there leaves the user typing into nothing — the same failure the
  // closed-details cases above guard against, reached by a different route.
  // Only typing can show it: an assertion on the caret's anchor node would
  // happily report the locked element as the landing spot.
  test('Backspace after details with a locked body types into the summary', async ({ page }) => {
    await mountEditor(
      page,
      '<details open=""><summary>Title</summary>' +
        '<div contenteditable="false">locked</div></details><p><br></p>',
    );
    await focusEditor(page);
    await caretAtStart(page, '#ahve-root > p:last-child');

    await page.keyboard.press('Backspace');
    await page.keyboard.type('x');

    expect(await getRootHtml(page)).toBe(
      '<details open=""><summary>Titlex</summary>' +
        '<div contenteditable="false">locked</div></details>',
    );
  });

  // A details body need not be wrapped in a block — renderer.ts installs body
  // content verbatim, so a .html file from disk can put bare text straight
  // after the </summary>. The body is OPEN and therefore visible here, so the
  // hand-over to the summary that a closed details needs would be a caret
  // travelling backwards past text the reader can see. Typing is what shows
  // which of the two happened.
  test('Backspace after details with a bare-text body types at the end of that text', async ({ page }) => {
    await mountEditor(
      page,
      '<details open=""><summary>Title</summary>body</details><p><br></p>',
    );
    await focusEditor(page);
    await caretAtStart(page, '#ahve-root > p:last-child');

    await page.keyboard.press('Backspace');
    await page.keyboard.type('x');

    expect(await getRootHtml(page)).toBe(
      '<details open=""><summary>Title</summary>bodyx</details>',
    );
  });

  test('Delete at the end of a bare-text details body keeps typing in that text', async ({ page }) => {
    await mountEditor(
      page,
      '<details open=""><summary>Title</summary>body</details><p><br></p>',
    );
    await focusEditor(page);
    await page.evaluate(() => {
      const text = document.querySelector('#ahve-root details')!.lastChild!;
      const range = document.createRange();
      range.setStart(text, text.textContent!.length);
      range.collapse(true);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });

    await page.keyboard.press('Delete');
    await page.keyboard.type('x');

    expect(await getRootHtml(page)).toBe(
      '<details open=""><summary>Title</summary>bodyx</details>',
    );
  });

  test('Backspace after details with a list body places typing inside the last item', async ({ page }) => {
    await mountEditor(
      page,
      '<details open=""><summary>Title</summary><ul><li>a</li></ul></details><p><br></p>',
    );
    await focusEditor(page);
    await caretAtStart(page, '#ahve-root > p');

    await page.keyboard.press('Backspace');
    await page.keyboard.type('x');

    expect(await getRootHtml(page)).toBe(
      '<details open=""><summary>Title</summary><ul><li>ax</li></ul></details>',
    );
  });

  test('Backspace applies native editing to a nested list item inside details', async ({ page }) => {
    await mountEditor(
      page,
      '<details open=""><summary>Title</summary>' +
        '<ul><li>a<ul><li>b</li></ul></li></ul></details>',
    );
    await focusEditor(page);
    await caretAtStart(page, '#ahve-root ul ul li');

    await page.keyboard.press('Backspace');

    expect(await getRootHtml(page)).toBe(
      '<details open=""><summary>Title</summary>' +
        '<ul><li>ab</li></ul></details>',
    );
  });

  test('Backspace removes an empty pre after its last code character is deleted', async ({ page }) => {
    await mountEditor(page, '<pre><code>a</code></pre>');
    await focusEditor(page);
    await caretAtEnd(page, '#ahve-root code');

    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');

    expect(await getRootHtml(page)).toBe('<p><br></p>');
  });

  test('Backspace removes an empty pre after hr and creates a paragraph for typing', async ({ page }) => {
    await mountEditor(page, '<hr><pre><code>a</code></pre>');
    await focusEditor(page);
    await caretAtEnd(page, '#ahve-root code');

    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await page.keyboard.type('x');

    expect(await getRootHtml(page)).toBe('<hr><p>x</p>');
  });

  test('Backspace removes an empty paragraph after pre inside details', async ({ page }) => {
    await mountEditor(
      page,
      '<details open=""><summary>Title</summary>' +
        '<pre><code>code</code></pre><p><br></p></details>',
    );
    await focusEditor(page);
    await caretAtStart(page, '#ahve-root details > p');

    await page.keyboard.press('Backspace');
    await page.keyboard.type('x');

    expect(await getRootHtml(page)).toBe(
      '<details open=""><summary>Title</summary><pre><code>codex</code></pre></details>',
    );
  });

  test('Backspace deletes a leading code-block newline', async ({ page }) => {
    await mountEditor(page, '<pre><code>\nabc</code></pre>');
    await focusEditor(page);
    await page.evaluate(() => {
      const text = document.querySelector('#ahve-root code')!.firstChild!;
      const range = document.createRange();
      range.setStart(text, 1);
      range.collapse(true);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });

    await page.keyboard.press('Backspace');

    expect(await getRootHtml(page)).toBe('<pre><code>abc</code></pre>');
  });

  // The protection climbs out of a container to reach its structural
  // neighbour, so the empty-block drop climbs too. Without it this keystroke is
  // consumed and nothing happens at all, while the identical bare
  // <p><br></p> in the same position is removed.
  test('Backspace removes an empty list item and its list after pre', async ({ page }) => {
    await mountEditor(page, '<pre><code>code</code></pre><ul><li><br></li></ul>');
    await focusEditor(page);
    await caretAtStart(page, '#ahve-root li');

    await page.keyboard.press('Backspace');
    await page.keyboard.type('x');

    expect(await getRootHtml(page)).toBe('<pre><code>codex</code></pre>');
  });

  test('Backspace removes only the empty first item of a list after pre', async ({ page }) => {
    await mountEditor(
      page,
      '<pre><code>code</code></pre><ul><li><br></li><li>b</li></ul>',
    );
    await focusEditor(page);
    await caretAtStart(page, '#ahve-root li');

    await page.keyboard.press('Backspace');
    await page.keyboard.type('x');

    expect(await getRootHtml(page)).toBe(
      '<pre><code>codex</code></pre><ul><li>b</li></ul>',
    );
  });

  // A container the drop may NOT unwind: removing the empty paragraph would
  // take the cell, the row, and the whole table with it. The drop declines and
  // the keystroke falls back to the structural protection.
  test('Backspace in an empty table cell after pre leaves the table alone', async ({ page }) => {
    const html =
      '<pre><code>code</code></pre>' +
      '<table><tbody><tr><td><p><br></p></td></tr></tbody></table>';
    await mountEditor(page, html);
    await focusEditor(page);
    await caretAtStart(page, '#ahve-root td > p');

    await page.keyboard.press('Backspace');

    expect(await getRootHtml(page)).toBe(html);
  });

  test('Backspace in an empty list item that is the whole details body keeps it', async ({ page }) => {
    const html =
      '<details open=""><summary>Title</summary><ul><li><br></li></ul></details>';
    await mountEditor(page, html);
    await focusEditor(page);
    await caretAtStart(page, '#ahve-root li');

    await page.keyboard.press('Backspace');

    expect(await getRootHtml(page)).toBe(html);
  });

  test('Backspace at the first list item cannot merge it into summary', async ({ page }) => {
    const html =
      '<details open=""><summary>Title</summary><ul><li>a</li></ul></details>';
    await mountEditor(page, html);
    await focusEditor(page);
    await caretAtStart(page, '#ahve-root li');

    await page.keyboard.press('Backspace');

    expect(await getRootHtml(page)).toBe(html);
  });

  // Emptying the only code block of a details must not remove the body: the
  // pre degrades to an empty paragraph so the structure keeps a place to type.
  test('Backspace in an emptied code block inside details keeps a details body', async ({ page }) => {
    await mountEditor(
      page,
      '<details open=""><summary>Title</summary><pre><code>a</code></pre></details>',
    );
    await focusEditor(page);
    await caretAtEnd(page, '#ahve-root code');

    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await page.keyboard.type('x');

    expect(await getRootHtml(page)).toBe(
      '<details open=""><summary>Title</summary><p>x</p></details>',
    );
  });

  // The pre/details is a sibling of the LIST or QUOTE, not of the caret's own
  // block. The protection still has to reach it — see the native probes at the
  // bottom of this file for what Chromium does when it does not.
  test('Backspace at the first list item after pre preserves both blocks', async ({ page }) => {
    const html = '<pre><code>code</code></pre><ul><li>a</li></ul>';
    await mountEditor(page, html);
    await focusEditor(page);
    await caretAtStart(page, '#ahve-root li');

    await page.keyboard.press('Backspace');

    expect(await getRootHtml(page)).toBe(html);
  });

  test('Backspace in the first quoted paragraph after details preserves both blocks', async ({ page }) => {
    const html =
      '<details open=""><summary>Title</summary><p>body</p></details>' +
      '<blockquote><p>x</p></blockquote>';
    await mountEditor(page, html);
    await focusEditor(page);
    await caretAtStart(page, '#ahve-root blockquote p');

    await page.keyboard.press('Backspace');

    expect(await getRootHtml(page)).toBe(html);
  });

  test('Backspace at the start of pre preceded by hr keeps the hr', async ({ page }) => {
    const html = '<hr><pre><code>code</code></pre>';
    await mountEditor(page, html);
    await focusEditor(page);
    await caretAtStart(page, '#ahve-root code');

    await page.keyboard.press('Backspace');

    expect(await getRootHtml(page)).toBe(html);
  });

  test('Delete at the end of pre followed by hr keeps the hr', async ({ page }) => {
    const html = '<pre><code>code</code></pre><hr>';
    await mountEditor(page, html);
    await focusEditor(page);
    await caretAtEnd(page, '#ahve-root code');

    await page.keyboard.press('Delete');

    expect(await getRootHtml(page)).toBe(html);
  });

  // Emptying a code block leaves Chromium's own <pre><br></pre> shape. Delete
  // there drops the placeholder and lands on the next block; it must not hand
  // the keystroke back (the probe below shows what that costs).
  test('Delete in an emptied code block drops it and lands on the next paragraph', async ({ page }) => {
    await mountEditor(page, '<pre><code>a</code></pre><p>text</p>');
    await focusEditor(page);
    await caretAtEnd(page, '#ahve-root code');

    await page.keyboard.press('Backspace');
    await page.keyboard.press('Delete');
    await page.keyboard.type('x');

    expect(await getRootHtml(page)).toBe('<p>xtext</p>');
  });

  // Inline content with no wrapping block. renderer.ts installs body content
  // verbatim, so a .html file that puts text straight after a </pre> keeps that
  // shape in the view — and the caret there has no block for the boundary test
  // to ask about. The native probe at the bottom of this file shows what the
  // browser does with it.
  test('Backspace in bare root text after pre preserves the code structure', async ({ page }) => {
    const html = '<pre><code>code</code></pre>text';
    await mountEditor(page, html);
    await focusEditor(page);
    await page.evaluate(() => {
      const text = document.querySelector('#ahve-root')!.lastChild!;
      const range = document.createRange();
      range.setStart(text, 0);
      range.collapse(true);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });

    await page.keyboard.press('Backspace');

    expect(await getRootHtml(page)).toBe(html);
  });

  // The same bare run one container in. An ordinary block hosting both a <pre>
  // and loose text has exactly the root case's problem — the block IS the
  // container, so its own start sits before the <pre> and the block-level edge
  // test never fires — and the native probe for the root shape at the bottom of
  // this file is what the default does here too. Wrapping the same text in a
  // <p> is protected, so without this the guard depended on whether the
  // imported file happened to use a paragraph.
  test('Backspace in bare text after a pre inside a div preserves the code structure', async ({ page }) => {
    const html = '<div><pre><code>code</code></pre>text</div>';
    await mountEditor(page, html);
    await focusEditor(page);
    await page.evaluate(() => {
      const text = document.querySelector('#ahve-root div')!.lastChild!;
      const range = document.createRange();
      range.setStart(text, 0);
      range.collapse(true);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });

    await page.keyboard.press('Backspace');

    expect(await getRootHtml(page)).toBe(html);
  });

  test('Delete in bare text before details inside a blockquote preserves it', async ({ page }) => {
    const html =
      '<blockquote>text<details open=""><summary>Title</summary>' +
      '<p>body</p></details></blockquote>';
    await mountEditor(page, html);
    await focusEditor(page);
    await page.evaluate(() => {
      const text = document.querySelector('#ahve-root blockquote')!.firstChild!;
      const range = document.createRange();
      range.setStart(text, text.textContent!.length);
      range.collapse(true);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });

    await page.keyboard.press('Delete');

    expect(await getRootHtml(page)).toBe(html);
  });

  test('Backspace at the start of a bare details body preserves the summary', async ({ page }) => {
    const html = '<details open=""><summary>Title</summary>body</details>';
    await mountEditor(page, html);
    await focusEditor(page);
    await page.evaluate(() => {
      const text = document.querySelector('#ahve-root details')!.lastChild!;
      const range = document.createRange();
      range.setStart(text, 0);
      range.collapse(true);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });

    await page.keyboard.press('Backspace');

    expect(await getRootHtml(page)).toBe(html);
  });

  test('Delete at the end of bare root text before details preserves it', async ({ page }) => {
    const html = 'text<details open=""><summary>Title</summary><p>body</p></details>';
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

    await page.keyboard.press('Delete');

    expect(await getRootHtml(page)).toBe(html);
  });

  // An ELEMENT-level caret in a bare run's host: the caret sits between the
  // host's children, not inside a text node. Every bare-run case above uses a
  // text-node caret, and this position is the one a sibling-of-the-run lookup
  // cannot resolve at all. It is reachable in the real editor — deleting an
  // anchorless comment parks the caret at exactly this kind of offset — and the
  // native probe at the bottom of this file shows what the default does here.
  test('Backspace at a root-level caret offset after pre preserves the code structure', async ({ page }) => {
    const html = '<pre><code>code</code></pre>text';
    await mountEditor(page, html);
    await focusEditor(page);
    await page.evaluate(() => {
      const range = document.createRange();
      range.setStart(document.querySelector('#ahve-root')!, 1);
      range.collapse(true);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });

    await page.keyboard.press('Backspace');

    expect(await getRootHtml(page)).toBe(html);
  });

  test('Backspace at a details caret offset after its summary preserves the summary', async ({ page }) => {
    const html = '<details open=""><summary>Title</summary>body</details>';
    await mountEditor(page, html);
    await focusEditor(page);
    await page.evaluate(() => {
      const range = document.createRange();
      range.setStart(document.querySelector('#ahve-root details')!, 1);
      range.collapse(true);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });

    await page.keyboard.press('Backspace');

    expect(await getRootHtml(page)).toBe(html);
  });

  test('Delete at the details body end cannot pull outside text into details', async ({ page }) => {
    const html =
      '<details open=""><summary>Title</summary><p>body</p></details><p>tail</p>';
    await mountEditor(page, html);
    await focusEditor(page);
    await caretAtEnd(page, '#ahve-root details > p');

    await page.keyboard.press('Delete');

    expect(await getRootHtml(page)).toBe(html);
  });
});

// What the structural protection is standing in front of. Measured on a bare
// contenteditable the editor never binds to, because a handler preventDefault()s
// first on #ahve-root and the assertion would only restate our own behavior.
// These lock in that the protection has to reach a structural sibling of the
// caret's CONTAINER, not just of the caret's own block: Chromium does not break
// a list item or a quoted paragraph out of its container.
test.describe('Chromium structural merge defaults (native probe)', () => {
  test('Backspace at the first list item merges it into the previous pre', async ({ page }) => {
    await mountNativeProbe(page, '<pre><code>code</code></pre><ul><li>a</li></ul>');
    await caretAtStart(page, `${NATIVE_PROBE} li`);

    await page.keyboard.press('Backspace');

    // The item moves inside the <pre> but OUTSIDE its <code> wrapper.
    expect(await getNativeProbeHtml(page)).toBe('<pre><code>code</code>a</pre>');
  });

  test('Backspace in the first quoted paragraph merges it into the previous details', async ({ page }) => {
    await mountNativeProbe(
      page,
      '<details open=""><summary>Title</summary><p>body</p></details>' +
        '<blockquote><p>x</p></blockquote>',
    );
    await caretAtStart(page, `${NATIVE_PROBE} blockquote p`);

    await page.keyboard.press('Backspace');

    const html = await getNativeProbeHtml(page);
    expect(html).not.toContain('<blockquote>');
    expect(await page.locator(`${NATIVE_PROBE} details > p`).evaluate((n) => n.textContent))
      .toBe('bodyx');
  });

  // Bare inline content has no block for a boundary test to ask about, and the
  // browser default there is the same structural merge as for a list item: the
  // text lands inside the <pre> but outside its <code>.
  test('Backspace at the start of bare root text merges it into the previous pre', async ({ page }) => {
    await mountNativeProbe(page, '<pre><code>code</code></pre>text');
    await page.evaluate((probe) => {
      const text = document.querySelector(probe)!.lastChild!;
      const range = document.createRange();
      range.setStart(text, 0);
      range.collapse(true);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    }, NATIVE_PROBE);

    await page.keyboard.press('Backspace');

    const html = await getNativeProbeHtml(page);
    expect(html).not.toBe('<pre><code>code</code></pre>text');
    expect(await page.locator(`${NATIVE_PROBE} code`).evaluate((n) => n.textContent))
      .toBe('code');
    expect(await page.locator(`${NATIVE_PROBE} pre`).evaluate((n) => n.textContent))
      .toContain('text');
  });

  // The element-level twin of the bare-root probe above. The caret is at the
  // root's own child offset rather than in the text node, and the default is
  // the same structural merge — so the guard has to cover this shape too.
  test('Backspace at a root-level caret offset after pre merges the text into it', async ({ page }) => {
    await mountNativeProbe(page, '<pre><code>code</code></pre>text');
    await page.evaluate((probe) => {
      const range = document.createRange();
      range.setStart(document.querySelector(probe)!, 1);
      range.collapse(true);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    }, NATIVE_PROBE);

    await page.keyboard.press('Backspace');

    expect(await getNativeProbeHtml(page)).not.toBe('<pre><code>code</code></pre>text');
    expect(await page.locator(`${NATIVE_PROBE} code`).evaluate((n) => n.textContent))
      .toBe('code');
  });

  test('Delete in an emptied pre pulls the next paragraph inside it', async ({ page }) => {
    await mountNativeProbe(page, '<pre><br></pre><p>text</p>');
    await caretAtStart(page, `${NATIVE_PROBE} pre`);

    await page.keyboard.press('Delete');

    const html = await getNativeProbeHtml(page);
    expect(html).not.toContain('<p>');
    expect(await page.locator(`${NATIVE_PROBE} pre`).evaluate((n) => n.textContent))
      .toContain('text');
  });

  // The same emptied pre with a neighbour that can hold no caret. The editor's
  // empty-pre drop declines there (nowhere to put the caret), so this is the
  // default the placeholder rule in isCaretAtStructuralBlockEdge stands in
  // front of. One keystroke takes the <hr> AND the pre's own placeholder,
  // leaving a <pre> with no line in it at all — a shape no command emits and
  // that the user cannot type into.
  test('Delete in an emptied pre before an hr takes the hr and the placeholder', async ({ page }) => {
    await mountNativeProbe(page, '<pre><br></pre><hr>');
    await caretAtStart(page, `${NATIVE_PROBE} pre`);

    await page.keyboard.press('Delete');

    expect(await getNativeProbeHtml(page)).toBe('<pre></pre>');
  });
});
