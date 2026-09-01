import { expect, test } from '@playwright/test';
import {
  caretAtStart,
  mountEditor,
  openHost,
  saveAndGetHtml,
} from './helpers/page';

const PREVIEW = '[data-ahve-mermaid-preview]';

test.describe('Mermaid diagrams', () => {
  test('renders both public source forms and saves only their original HTML', async ({ page }) => {
    const html =
      '<pre class="mermaid">graph TD\n  A--&gt;B\n</pre>\n' +
      '<pre><code class="language-mermaid">sequenceDiagram\n  A-&gt;&gt;B: Hello\n</code></pre>';
    await mountEditor(page, html);

    await expect(page.locator(PREVIEW)).toHaveCount(2);
    await expect(page.locator(`${PREVIEW}[data-ahve-mermaid-state="ready"]`)).toHaveCount(2, {
      timeout: 15_000,
    });
    await expect(page.locator(`${PREVIEW} svg`)).toHaveCount(2);
    await expect(page.locator('[data-ahve-mermaid-source]').first()).toBeHidden();

    expect(await saveAndGetHtml(page)).toBe(html);
  });

  test('does not load the Mermaid runtime for an ordinary document', async ({ page }) => {
    await openHost(page);
    await page.evaluate(() => {
      window.dispatchEvent(
        new MessageEvent('message', { data: { type: 'init', html: '<p>ordinary</p>' } }),
      );
    });

    await page.waitForTimeout(100);
    await expect(page.locator('script[src$="mermaid.js"]')).toHaveCount(0);
    await expect(page.locator(PREVIEW)).toHaveCount(0);
  });

  test('edits a diagram through the dialog and supports undo and redo', async ({ page }) => {
    const original = '<pre class="mermaid">graph TD</pre>';
    const edited = '<pre class="mermaid">graph LR\nA--&gt;B</pre>';
    await mountEditor(page, original);
    await expect(page.locator(`${PREVIEW}[data-ahve-mermaid-state="ready"]`)).toHaveCount(1, {
      timeout: 15_000,
    });

    await page.locator(PREVIEW).click();
    const textarea = page.locator('#ahve-mermaid-source-input');
    await expect(textarea).toHaveValue('graph TD');
    await textarea.fill('graph LR\nA-->B');
    await page.getByRole('button', { name: 'Apply' }).click();

    await expect(page.locator(`${PREVIEW}[data-ahve-mermaid-state="ready"]`)).toHaveCount(1);
    expect(await saveAndGetHtml(page)).toBe(edited);

    await page.keyboard.press('Control+z');
    await expect(page.locator(`${PREVIEW}[data-ahve-mermaid-state="ready"]`)).toHaveCount(1);
    expect(await saveAndGetHtml(page)).toBe(original);

    await page.keyboard.press('Control+y');
    await expect(page.locator(`${PREVIEW}[data-ahve-mermaid-state="ready"]`)).toHaveCount(1);
    expect(await saveAndGetHtml(page)).toBe(edited);
  });

  test('keeps invalid source and exposes it for correction', async ({ page }) => {
    const html = '<pre class="mermaid">this is not a diagram</pre>';
    await mountEditor(page, html);

    const preview = page.locator(`${PREVIEW}[data-ahve-mermaid-state="error"]`);
    await expect(preview).toHaveCount(1, { timeout: 15_000 });
    await expect(preview).toContainText('Mermaid error:');
    expect(await saveAndGetHtml(page)).toBe(html);

    await preview.click();
    await expect(page.locator('#ahve-mermaid-source-input')).toHaveValue(
      'this is not a diagram',
    );
    await page.getByRole('button', { name: 'Cancel' }).click();
    expect(await saveAndGetHtml(page)).toBe(html);
  });

  test('re-renders when the VS Code color theme changes', async ({ page }) => {
    await mountEditor(page, '<pre class="mermaid">graph TD\nA--&gt;B</pre>');
    const svg = page.locator(`${PREVIEW} svg`);
    await expect(svg).toHaveCount(1, { timeout: 15_000 });
    const firstId = await svg.getAttribute('id');

    await page.evaluate(() => document.body.classList.add('vscode-dark'));
    await expect.poll(async () => page.locator(`${PREVIEW} svg`).getAttribute('id')).not.toBe(firstId);
  });

  test('protects an adjacent text block from merging into the diagram', async ({ page }) => {
    const html = '<pre class="mermaid">graph TD\nA--&gt;B</pre>\n<p>tail</p>';
    await mountEditor(page, html);
    await expect(page.locator(`${PREVIEW}[data-ahve-mermaid-state="ready"]`)).toHaveCount(1, {
      timeout: 15_000,
    });

    await caretAtStart(page, 'p');
    await page.keyboard.press('Backspace');

    expect(await saveAndGetHtml(page)).toBe(html);
  });

  test('deletes a diagram from its dialog and supports undo and redo', async ({ page }) => {
    const original = '<h2>Before</h2>\n<pre class="mermaid">graph TD\nA--&gt;B</pre>\n<p>After</p>';
    const deleted = '<h2>Before</h2>\n\n<p>After</p>';
    await mountEditor(page, original);
    await expect(page.locator(`${PREVIEW}[data-ahve-mermaid-state="ready"]`)).toHaveCount(1, {
      timeout: 15_000,
    });

    await page.locator(PREVIEW).click();
    await page.getByRole('button', { name: 'Delete diagram' }).click();

    await expect(page.locator(PREVIEW)).toHaveCount(0);
    expect(await saveAndGetHtml(page)).toBe(deleted);

    await page.keyboard.press('Control+z');
    await expect(page.locator(`${PREVIEW}[data-ahve-mermaid-state="ready"]`)).toHaveCount(1, {
      timeout: 15_000,
    });
    expect(await saveAndGetHtml(page)).toBe(original);

    await page.keyboard.press('Control+y');
    await expect(page.locator(PREVIEW)).toHaveCount(0);
    expect(await saveAndGetHtml(page)).toBe(deleted);
  });

  test('inserts a diagram from the toolbar and opens its dialog immediately', async ({ page }) => {
    await mountEditor(page, '<p>Before</p>\n<p>After</p>');
    await caretAtStart(page, 'p:last-child');

    await page.getByRole('button', { name: 'Mermaid' }).click();
    const textarea = page.locator('#ahve-mermaid-source-input');
    await expect(textarea).toBeFocused();
    await expect(textarea).toHaveValue('graph TD\n  A --> B');
    await expect(page.getByRole('button', { name: 'Delete diagram' })).toHaveCount(0);
    await textarea.fill('graph LR\n  Start --> End');
    await page.getByRole('button', { name: 'Apply' }).click();

    await expect(page.locator(`${PREVIEW}[data-ahve-mermaid-state="ready"]`)).toHaveCount(1, {
      timeout: 15_000,
    });
    const children = await page.locator('#ahve-root').evaluate((root) =>
      Array.from(root.children).map((element) => element.tagName));
    expect(children).toEqual(['P', 'PRE', 'P']);
    expect(await saveAndGetHtml(page)).toBe(
      '<p>Before</p>\n<pre class="mermaid">graph LR\n  Start --&gt; End</pre>\n<p>After</p>',
    );
  });
});
