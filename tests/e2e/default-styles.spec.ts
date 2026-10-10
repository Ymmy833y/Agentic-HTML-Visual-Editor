import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { EDITOR_ROOT_ELEMENT_ID } from '../../common/index';
import { openWebviewHost, sendToWebview } from './helpers/page';

const EDITOR_ROOT = `#${EDITOR_ROOT_ELEMENT_ID}`;

// The base URIs can be empty because these tests cover only appearance and do not use them.
function initialize(body: string): Record<string, unknown> {
  return {
    type: 'initialize',
    text: `<html><body>${body}</body></html>`,
    documentUri: '',
    resourceRootUri: '',
  };
}

function readStyle(page: Page, selector: string, property: string): Promise<string> {
  return page
    .locator(selector)
    .evaluate((element, name) => getComputedStyle(element).getPropertyValue(name), property);
}

// VS Code sets theme variables on the root element. Set them in the same place to simulate a theme.
async function giveThemeVariable(page: Page, name: string, value: string): Promise<void> {
  await page.evaluate(
    (variable: { name: string; value: string }) => {
      document.documentElement.style.setProperty(variable.name, variable.value);
    },
    { name, value },
  );
}

// VS Code marks a high contrast theme with a class on the body. Put it in the same place to simulate one.
async function giveHighContrastClass(page: Page, name: string): Promise<void> {
  await page.evaluate((className) => document.body.classList.add(className), name);
}

// VS Code puts a default stylesheet into every webview that colors code with this theme variable. In the light high
// contrast theme the color is white. Reproduce that rule and color to simulate it.
async function giveVsCodeCodeColor(page: Page): Promise<void> {
  await page.addStyleTag({ content: 'code { color: var(--vscode-textPreformat-foreground); }' });
  await giveThemeVariable(page, '--vscode-textPreformat-foreground', 'rgb(255, 255, 255)');
}

test.describe('default style scope', () => {
  test('adds a left border to a blockquote inside the editor root', async ({ page }) => {
    await openWebviewHost(page);

    await sendToWebview(page, initialize('<blockquote id="quote">a</blockquote>'));

    const width = await readStyle(page, `${EDITOR_ROOT} #quote`, 'border-left-width');
    expect(Number.parseFloat(width)).toBeGreaterThan(0);
  });

  test('does not add a left border to a blockquote outside the editor root', async ({ page }) => {
    await openWebviewHost(page);

    await page.evaluate(() => {
      const quote = document.createElement('blockquote');
      quote.id = 'outside-quote';
      document.body.append(quote);
    });

    expect(await readStyle(page, '#outside-quote', 'border-left-width')).toBe('0px');
  });

  test('applies the background color to the view container outside the document body', async ({ page }) => {
    await openWebviewHost(page);

    // If it remains transparent, only the document body has a color and the surrounding area keeps
    // the view container's default color.
    expect(await readStyle(page, 'body', 'background-color')).not.toBe('rgba(0, 0, 0, 0)');
  });

  test('spans the document body across the full width of a wide view, keeping the side padding of 2.5em', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 800 });
    await openWebviewHost(page);

    await sendToWebview(page, initialize('<p>a</p>'));

    expect(await page.locator(EDITOR_ROOT).evaluate((root) => {
      const parent = root.parentElement;
      if (parent === null) {
        return 'no parent';
      }
      const outer = getComputedStyle(parent);
      const inside = parent.clientWidth - parseFloat(outer.paddingLeft) - parseFloat(outer.paddingRight);
      const style = getComputedStyle(root);
      const fontSize = parseFloat(style.fontSize);
      return {
        fullWidth: Math.abs(root.getBoundingClientRect().width - inside) < 1,
        padding: [parseFloat(style.paddingLeft) / fontSize, parseFloat(style.paddingRight) / fontSize],
      };
    })).toEqual({ fullWidth: true, padding: [2.5, 2.5] });
  });
});

test.describe('precedence over default styles', () => {
  test('lets an inline foreground color override the default foreground color', async ({ page }) => {
    await openWebviewHost(page);

    await sendToWebview(page, initialize('<p id="text" style="color: rgb(1, 2, 3)">a</p>'));

    expect(await readStyle(page, `${EDITOR_ROOT} #text`, 'color')).toBe('rgb(1, 2, 3)');
  });

  test('lets inline text alignment on a table cell override the default style', async ({ page }) => {
    await openWebviewHost(page);

    await sendToWebview(
      page,
      initialize('<table><tbody><tr><td id="cell" style="text-align: right">a</td></tr></tbody></table>'),
    );

    expect(await readStyle(page, `${EDITOR_ROOT} #cell`, 'text-align')).toBe('right');
  });

  test('uses an inline column width as a percentage of the table width', async ({ page }) => {
    await openWebviewHost(page);

    await sendToWebview(
      page,
      initialize(
        '<table id="grid"><colgroup><col style="width:25%"><col style="width:75%"></colgroup><tbody><tr><td>a</td><td>b</td></tr></tbody></table>',
      ),
    );

    // Check the ratio against the table width. If the table no longer fills the available width,
    // the denominator shrinks to the content width and this assertion fails.
    const share = await page.locator(`${EDITOR_ROOT} #grid`).evaluate((table) => {
      const cells = table.querySelectorAll('td');
      return cells[1].getBoundingClientRect().width / table.getBoundingClientRect().width;
    });

    expect(share).toBeCloseTo(0.75, 2);
  });
});

test.describe('theme integration', () => {
  test('uses the fallback foreground color when theme variables are unavailable', async ({ page }) => {
    await openWebviewHost(page);

    await sendToWebview(page, initialize('<p id="text">a</p>'));

    expect(await readStyle(page, `${EDITOR_ROOT} #text`, 'color')).toBe('rgb(31, 35, 40)');
  });

  test('applies the foreground theme variable to the document body', async ({ page }) => {
    await openWebviewHost(page);
    await sendToWebview(page, initialize('<p id="text">a</p>'));

    await giveThemeVariable(page, '--vscode-editor-foreground', 'rgb(1, 2, 3)');

    expect(await readStyle(page, `${EDITOR_ROOT} #text`, 'color')).toBe('rgb(1, 2, 3)');
  });

  test('applies the background theme variable to the view container', async ({ page }) => {
    await openWebviewHost(page);

    await giveThemeVariable(page, '--vscode-editor-background', 'rgb(4, 5, 6)');

    expect(await readStyle(page, 'body', 'background-color')).toBe('rgb(4, 5, 6)');
  });

  test('applies the font-size theme variable as the base font size', async ({ page }) => {
    await openWebviewHost(page);
    await sendToWebview(page, initialize('<p id="text">a</p>'));

    await giveThemeVariable(page, '--vscode-font-size', '20px');

    expect(await readStyle(page, `${EDITOR_ROOT} #text`, 'font-size')).toBe('20px');
  });

  test('scales the heading font size proportionally with the base font size', async ({ page }) => {
    await openWebviewHost(page);
    await sendToWebview(page, initialize('<h1 id="heading">a</h1><p id="text">a</p>'));
    const baseBefore = await readStyle(page, `${EDITOR_ROOT} #text`, 'font-size');
    const headingBefore = await readStyle(page, `${EDITOR_ROOT} #heading`, 'font-size');

    await giveThemeVariable(page, '--vscode-font-size', '20px');

    // An absolute heading size would break the ratio when only the base changes. Checking the ratio
    // avoids duplicating the actual values in the test.
    const baseAfter = await readStyle(page, `${EDITOR_ROOT} #text`, 'font-size');
    const headingAfter = await readStyle(page, `${EDITOR_ROOT} #heading`, 'font-size');
    expect(Number.parseFloat(headingAfter) / Number.parseFloat(baseAfter)).toBeCloseTo(
      Number.parseFloat(headingBefore) / Number.parseFloat(baseBefore),
    );
  });

  test('keeps the document font family unchanged when a font-family theme variable is set', async ({ page }) => {
    await openWebviewHost(page);
    await sendToWebview(page, initialize('<p id="text">a</p>'));
    const before = await readStyle(page, `${EDITOR_ROOT} #text`, 'font-family');

    await giveThemeVariable(page, '--vscode-font-family', '"Comic Sans MS"');

    expect(await readStyle(page, `${EDITOR_ROOT} #text`, 'font-family')).toBe(before);
  });
});

test.describe('code block frame in high contrast themes', () => {
  const CODE_BLOCK = '<pre id="code"><code>a</code></pre>';

  test('frames a code block with a solid border in a high contrast theme', async ({ page }) => {
    await openWebviewHost(page);
    await sendToWebview(page, initialize(CODE_BLOCK));

    await giveHighContrastClass(page, 'vscode-high-contrast');

    expect(await readStyle(page, `${EDITOR_ROOT} #code`, 'border-top-style')).toBe('solid');
  });

  test('draws the frame of a code block in the border theme variable', async ({ page }) => {
    await openWebviewHost(page);
    await sendToWebview(page, initialize(CODE_BLOCK));
    await giveHighContrastClass(page, 'vscode-high-contrast');

    await giveThemeVariable(page, '--vscode-panel-border', 'rgb(7, 8, 9)');

    expect(await readStyle(page, `${EDITOR_ROOT} #code`, 'border-top-color')).toBe('rgb(7, 8, 9)');
  });

  test('frames a code block with the light high contrast class alone', async ({ page }) => {
    await openWebviewHost(page);
    await sendToWebview(page, initialize(CODE_BLOCK));

    await giveHighContrastClass(page, 'vscode-high-contrast-light');

    expect(await readStyle(page, `${EDITOR_ROOT} #code`, 'border-top-style')).toBe('solid');
  });

  test('leaves a code block without a frame outside high contrast themes', async ({ page }) => {
    await openWebviewHost(page);

    await sendToWebview(page, initialize(CODE_BLOCK));

    expect(await readStyle(page, `${EDITOR_ROOT} #code`, 'border-top-style')).toBe('none');
  });

  test('leaves a diagram source block without a frame in a high contrast theme', async ({ page }) => {
    await openWebviewHost(page);
    await sendToWebview(page, initialize('<pre id="diagram" class="mermaid"></pre>'));
    // Wait until the view has taken the block as a diagram; before that it is styled as an ordinary code block.
    await page.waitForFunction(
      () => document.getElementById('diagram')?.hasAttributeNS('urn:ahve:diagram', 'data-ahve-diagram-block') === true,
    );

    await giveHighContrastClass(page, 'vscode-high-contrast');

    expect(await readStyle(page, `${EDITOR_ROOT} #diagram`, 'border-top-style')).toBe('none');
  });
});

test.describe('code text color in high contrast themes', () => {
  const INLINE_CODE = '<p id="text" style="color: rgb(1, 2, 3)">a <code id="code">b</code></p>';

  test('gives inline code the color of the surrounding text in the light high contrast theme', async ({ page }) => {
    await openWebviewHost(page);
    await sendToWebview(page, initialize(INLINE_CODE));
    await giveVsCodeCodeColor(page);

    await giveHighContrastClass(page, 'vscode-high-contrast-light');

    expect(await readStyle(page, `${EDITOR_ROOT} #code`, 'color')).toBe('rgb(1, 2, 3)');
  });

  test('gives the code in a code block the body text color in the light high contrast theme', async ({ page }) => {
    await openWebviewHost(page);
    await sendToWebview(page, initialize('<pre><code id="code">a</code></pre>'));
    await giveVsCodeCodeColor(page);

    await giveHighContrastClass(page, 'vscode-high-contrast-light');

    expect(await readStyle(page, `${EDITOR_ROOT} #code`, 'color')).toBe('rgb(31, 35, 40)');
  });

  test('gives inline code the color of the surrounding text in the dark high contrast theme', async ({ page }) => {
    await openWebviewHost(page);
    await sendToWebview(page, initialize(INLINE_CODE));
    await giveVsCodeCodeColor(page);

    await giveHighContrastClass(page, 'vscode-high-contrast');

    expect(await readStyle(page, `${EDITOR_ROOT} #code`, 'color')).toBe('rgb(1, 2, 3)');
  });

  test('leaves the code color of VS Code outside high contrast themes', async ({ page }) => {
    await openWebviewHost(page);
    await sendToWebview(page, initialize(INLINE_CODE));

    await giveVsCodeCodeColor(page);

    expect(await readStyle(page, `${EDITOR_ROOT} #code`, 'color')).toBe('rgb(255, 255, 255)');
  });
});
