import { expect, test } from '@playwright/test';

import { EDITOR_ROOT_ELEMENT_ID } from '../../common/index';
import {
  EDITOR_ROOT,
  focusEditor,
  installReceiver,
  openEditor,
  placeCaret,
  pressPrimaryShortcut,
  readBodyHtml,
  readRecord,
  readRuleMarks,
  registerMarkingRule,
} from './helpers/editing';

test.describe('input dispatch', () => {
  test('inserts typed text into the same paragraph', async ({ page }) => {
    await openEditor(page, '\n<p>ab</p>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 1 });

    await page.keyboard.type('X');

    await expect(page.locator(`${EDITOR_ROOT} p`)).toHaveText('aXb');
  });

  // Bold is taken over by an input rule the inline format feature registers, so the default suppression
  // is checked with underline, which has no rule.
  test('suppresses underline formatting, which has no rule, without creating a format element', async ({ page }) => {
    await openEditor(page, '\n<p>ab</p>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 0 });
    await page.keyboard.press('Shift+ArrowRight');

    await pressPrimaryShortcut(page, 'u');

    await expect(page.locator(`${EDITOR_ROOT} u, ${EDITOR_ROOT} span[style]`)).toHaveCount(0);
  });

  test('suppresses history undo and retains typed text', async ({ page }) => {
    await openEditor(page, '\n<p>ab</p>\n');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 2 });
    await page.keyboard.type('X');

    await pressPrimaryShortcut(page, 'z');

    await expect(page.locator(`${EDITOR_ROOT} p`)).toHaveText('abX');
  });

  test('uses the first registered handling rule without calling later rules', async ({ page }) => {
    await openEditor(page, '\n<p>ab</p>\n');
    await registerMarkingRule(page, 'insertText', 'first', 'consumed');
    await registerMarkingRule(page, 'insertText', 'second', 'consumed');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 1 });

    await page.keyboard.type('X');

    expect(await readRuleMarks(page)).toEqual(['first']);
  });

  test('inserts no text and sends no notification when a rule handles without changing the tree', async ({ page }) => {
    await openEditor(page, '\n<p>ab</p>\n');
    await installReceiver(page);
    await registerMarkingRule(page, 'insertText', 'consuming', 'consumed');
    await focusEditor(page);
    await placeCaret(page, { selector: `${EDITOR_ROOT} p`, childIndex: 0, offset: 1 });

    await page.keyboard.type('X');

    expect(await readBodyHtml(page)).toBe('\n<p>ab</p>\n');
    expect((await readRecord(page)).kinds).toEqual([]);
  });

  test('suppresses input without trying rules when the selection is outside the editor root', async ({ page }) => {
    await openEditor(page, '\n<p>ab</p>\n');
    await registerMarkingRule(page, 'insertText', 'outside', 'edited');

    const prevented = await page.evaluate((rootId) => {
      const outside = document.createElement('p');
      outside.textContent = 'outside';
      document.body.append(outside);
      const range = document.createRange();
      range.selectNodeContents(outside);
      range.collapse(true);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);

      const event = new InputEvent('beforeinput', {
        inputType: 'insertText',
        data: 'X',
        cancelable: true,
        bubbles: true,
      });
      document.getElementById(rootId)?.dispatchEvent(event);
      return event.defaultPrevented;
    }, EDITOR_ROOT_ELEMENT_ID);

    expect(prevented).toBe(true);
    expect(await readRuleMarks(page)).toEqual([]);
  });
});
