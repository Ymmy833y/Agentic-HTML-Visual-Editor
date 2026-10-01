import type { Page } from '@playwright/test';

import { EDITOR_ROOT_ELEMENT_ID } from '../../../common/index';
import { PROBE_BUNDLE_PATH, openWebviewHost, sendToWebview } from './page';

/** Selector for the editor root. */
export const EDITOR_ROOT = `#${EDITOR_ROOT_ELEMENT_ID}`;

/** Values captured by the output receiver. */
export interface EditingRecord {
  /** Input types received through immediate notifications. */
  readonly kinds: string[];
  /** Bodies received after debouncing. */
  readonly bodies: string[];
}

/** Marks used to record rule invocation order. */
export interface RuleMarks {
  readonly marks: string[];
}

declare global {
  interface Window {
    __editingRecord?: { kinds: string[]; bodies: string[] };
    __ruleMarks?: string[];
  }
}

/** Position at which to place the caret. */
export interface CaretPosition {
  /** Selector for the element containing the position. */
  readonly selector: string;
  /** Index of the child node within that element. */
  readonly childIndex: number;
  /** Position within the child node. */
  readonly offset: number;
}

// Sends the fixture page with an editor root a document whose body has been replaced.
function initialize(body: string): Record<string, unknown> {
  return {
    type: 'initialize',
    text: `<!DOCTYPE html>\n<html><body>${body}</body></html>`,
    documentUri: '',
    resourceRootUri: '',
  };
}

/**
 * Opens the page with a bundle exposing the editing-session entry point and mounts a body.
 *
 * @param page The target page.
 * @param body The body to mount.
 */
export async function openEditor(page: Page, body: string): Promise<void> {
  await openWebviewHost(page, PROBE_BUNDLE_PATH);
  await sendToWebview(page, initialize(body));
}

/**
 * Focuses the editor root and places the caret at its start.
 *
 * @param page The target page.
 */
export async function focusEditor(page: Page): Promise<void> {
  await page.evaluate((rootId) => {
    const root = document.getElementById(rootId);
    if (root === null) {
      throw new Error('Editor root not found');
    }
    root.focus();
    const range = document.createRange();
    range.selectNodeContents(root);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, EDITOR_ROOT_ELEMENT_ID);
}

/**
 * Places the caret at a specified position.
 *
 * @param page The target page.
 * @param position The caret position.
 */
export async function placeCaret(page: Page, position: CaretPosition): Promise<void> {
  await page.evaluate((target) => {
    const element = document.querySelector(target.selector);
    if (element === null) {
      throw new Error(`Element not found: ${target.selector}`);
    }
    const range = document.createRange();
    range.setStart(element.childNodes[target.childIndex], target.offset);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, position);
}

/**
 * Registers an output receiver and starts recording notifications and bodies.
 *
 * @param page The target page.
 */
export async function installReceiver(page: Page): Promise<void> {
  await page.evaluate(() => {
    const record: { kinds: string[]; bodies: string[] } = { kinds: [], bodies: [] };
    window.__editingRecord = record;
    window.__editingSessionProbe?.()?.setOutputReceiver({
      onEditDetected: (kind) => record.kinds.push(kind),
      onBodyOutput: (output) => record.bodies.push(output.body),
    });
  });
}

/**
 * Reads the values captured by the output receiver.
 *
 * @param page The target page.
 * @returns The captured notifications and bodies.
 */
export async function readRecord(page: Page): Promise<EditingRecord> {
  return page.evaluate(() => window.__editingRecord ?? { kinds: [], bodies: [] });
}

/**
 * Registers a rule that records a mark when it handles input.
 *
 * @param page The target page.
 * @param inputType The input type for which to register the rule.
 * @param mark The mark recorded when the rule handles input.
 * @param result The result returned by the rule.
 */
export async function registerMarkingRule(
  page: Page,
  inputType: string,
  mark: string,
  result: 'pass' | 'edited' | 'consumed',
): Promise<void> {
  await page.evaluate((argument) => {
    window.__ruleMarks ??= [];
    window.__editingSessionProbe?.()?.registerRule(argument.inputType, () => {
      window.__ruleMarks?.push(argument.mark);
      return argument.result;
    });
  }, { inputType, mark, result });
}

/**
 * Reads the marks recorded by rules.
 *
 * @param page The target page.
 * @returns Marks in handling order.
 */
export async function readRuleMarks(page: Page): Promise<string[]> {
  return page.evaluate(() => window.__ruleMarks ?? []);
}

/**
 * Writes content to the clipboard and then performs the paste keystroke.
 *
 * Uses a real keystroke instead of a synthetic input event to cover the full path from the clipboard to the
 * delivered input type.
 *
 * @param page The target page.
 * @param data Clipboard content keyed by MIME type.
 */
export async function paste(page: Page, data: Record<string, string>): Promise<void> {
  await writeClipboard(page, data);
  await pressPrimaryShortcut(page, 'V');
}

/**
 * Writes content to the clipboard. Does not press any keys.
 *
 * @param page The page to operate on.
 * @param data The clipboard content per form (MIME type).
 */
export async function writeClipboard(page: Page, data: Record<string, string>): Promise<void> {
  await page.evaluate(async (entries) => {
    const item: Record<string, Blob> = {};
    for (const [type, value] of Object.entries(entries)) {
      item[type] = new Blob([value], { type });
    }
    await navigator.clipboard.write([new ClipboardItem(item)]);
  }, data);
}

/**
 * Presses a key combined with the platform's primary shortcut modifier (Meta on macOS, Control elsewhere).
 *
 * @param page The target page.
 * @param key The key to combine with the modifier.
 */
export async function pressPrimaryShortcut(page: Page, key: string): Promise<void> {
  await page.keyboard.press(`ControlOrMeta+${key}`);
}

/**
 * Selects all content with the platform's select-all keystroke.
 *
 * @param page The target page.
 */
export async function selectAll(page: Page): Promise<void> {
  await pressPrimaryShortcut(page, 'A');
}

/**
 * Deletes the word before the caret with the platform's keystroke.
 *
 * macOS assigns word deletion to Option+Backspace; Control+Backspace there deletes only one character.
 *
 * @param page The target page.
 */
export async function deleteWordBackward(page: Page): Promise<void> {
  await page.keyboard.press(process.platform === 'darwin' ? 'Alt+Backspace' : 'Control+Backspace');
}

/**
 * Dispatches an input type with no corresponding physical key to the editor root.
 *
 * @param page The target page.
 * @param inputType The input type to dispatch.
 * @returns `true` when default behavior was prevented.
 */
export async function dispatchBeforeInput(page: Page, inputType: string): Promise<boolean> {
  return page.evaluate((argument) => {
    const event = new InputEvent('beforeinput', {
      inputType: argument.inputType,
      cancelable: true,
      bubbles: true,
    });
    document.getElementById(argument.rootId)?.dispatchEvent(event);
    return event.defaultPrevented;
  }, { inputType, rootId: EDITOR_ROOT_ELEMENT_ID });
}

/**
 * Reads the contents of the editor root.
 *
 * @param page The target page.
 * @returns The editor root's `innerHTML`.
 */
export async function readBodyHtml(page: Page): Promise<string> {
  return page.locator(EDITOR_ROOT).innerHTML();
}
