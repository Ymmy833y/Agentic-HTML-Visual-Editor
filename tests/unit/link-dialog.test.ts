import { describe, expect, it } from 'vitest';

import { createLocalizer } from '../../common/index';
import type { FormatOperation } from '../../webview/editing/format-command';
import type { ActionDialogResult, ActionDialogSpec } from '../../webview/ui/action-dialog';
import { applyLinkDialogResult, openLinkDialog, validateLinkUrl } from '../../webview/ui/link-dialog';
import type { LinkDialogPorts } from '../../webview/ui/link-dialog';
import { createRange, mountRoot, readChildText, readElement, select } from './helpers/format-dom';

// A localizer that returns the message keys as they are. The kind of reason is told apart by the key.
const LOCALIZER = createLocalizer({});

/** Ports to replace. Without them, the dialog returns a confirmed result and the format commands and insertions are recorded. */
interface PortOverrides {
  readonly isInputStopped?: () => boolean;
  readonly openDialog?: (spec: ActionDialogSpec) => Promise<ActionDialogResult>;
  readonly runFormatCommand?: (operation: FormatOperation) => boolean;
}

/**
 * Creates doubles of the link dialog ports and records of the calls.
 *
 * @param root The editor root.
 * @param overrides The ports to replace.
 * @returns The ports and the records of the opened specs, format commands, insertions and diagnostics.
 */
function createPorts(root: Element, overrides: PortOverrides = {}): {
  ports: LinkDialogPorts;
  opened: ActionDialogSpec[];
  operations: FormatOperation[];
  inserted: string[];
  diagnostics: string[];
} {
  const opened: ActionDialogSpec[] = [];
  const operations: FormatOperation[] = [];
  const inserted: string[] = [];
  const diagnostics: string[] = [];
  const ports: LinkDialogPorts = {
    readEditorRoot: () => root,
    isComposing: () => false,
    isInputStopped: overrides.isInputStopped ?? (() => false),
    openDialog: overrides.openDialog ?? (async (spec) => {
      opened.push(spec);
      return { confirmed: true, values: { url: 'https://example.test/' } };
    }),
    runFormatCommand: overrides.runFormatCommand ?? ((operation) => {
      operations.push(operation);
      return true;
    }),
    insertLink: (url) => {
      inserted.push(url);
      return true;
    },
    localizer: LOCALIZER,
    reportDiagnostic: (detail) => diagnostics.push(detail),
  };
  return { ports, opened, operations, inserted, diagnostics };
}

/**
 * Selects text in the paragraph.
 *
 * @param root The editor root.
 * @param start The start character offset.
 * @param end The end character offset.
 */
function selectInParagraph(root: Element, start: number, end: number): void {
  const text = readChildText(readElement(root, 'p'), 0);
  select(createRange(text, start, text, end));
}

describe('the preconditions for opening the link dialog', () => {
  it('does not call the port that opens the dialog while input is stopped', async () => {
    const root = mountRoot('<p>abcd</p>');
    selectInParagraph(root, 1, 3);
    const { ports, opened } = createPorts(root, { isInputStopped: () => true });

    await openLinkDialog(ports);

    expect(opened).toEqual([]);
  });

  it('does not call the port that opens the dialog when the selection is outside the editor root', async () => {
    const root = mountRoot('<p>abcd</p>');
    const outside = document.createElement('p');
    outside.textContent = 'outside';
    document.body.append(outside);
    const text = readChildText(outside, 0);
    select(createRange(text, 1, text, 3));
    const { ports, opened } = createPorts(root);

    await openLinkDialog(ports);

    expect(opened).toEqual([]);
  });

  it('leaves no rejected Promise and one diagnostic line when the format command port throws while applying the result', async () => {
    const root = mountRoot('<p>abcd</p>');
    selectInParagraph(root, 1, 3);
    const { ports, diagnostics } = createPorts(root, {
      runFormatCommand: () => {
        throw new Error('The format command failed');
      },
    });

    const settled = await openLinkDialog(ports).then(() => 'resolved', () => 'rejected');

    expect([settled, diagnostics.length]).toEqual(['resolved', 1]);
  });
});

describe('the requirement of the link dialog field', () => {
  it('marks the URL field as required and gives the requirement badge texts', async () => {
    const root = mountRoot('<p>abcd</p>');
    selectInParagraph(root, 1, 3);
    const { ports, opened } = createPorts(root);

    await openLinkDialog(ports);

    expect([opened[0]?.fields.map((field) => [field.name, field.required]), opened[0]?.requirementLabels]).toEqual([
      [['url', true]],
      { required: 'actionDialog.required', optional: 'actionDialog.optional' },
    ]);
  });
});

describe('validating the URL', () => {
  it('passes https: and mailto: values, relative paths, and values starting with # and ?', () => {
    const values = ['https://example.test/', 'mailto:a@example.test', 'docs/a.html', '#top', '?q=1'];

    expect(values.map((value) => validateLinkUrl(value, LOCALIZER))).toEqual(values.map(() => undefined));
  });

  it('rejects empty and whitespace-only values with the reason asking for a URL', () => {
    expect([validateLinkUrl('', LOCALIZER), validateLinkUrl(' \t ', LOCALIZER)])
      .toEqual(['linkDialog.urlRequired', 'linkDialog.urlRequired']);
  });

  it('rejects values starting with javascript:, vbscript: and data:text/html with the reason that the URL cannot be used', () => {
    const values = ['javascript:alert(1)', 'vbscript:msgbox(1)', 'data:text/html,<p>a</p>'];

    expect(values.map((value) => validateLinkUrl(value, LOCALIZER)))
      .toEqual(values.map(() => 'linkDialog.urlUnsafe'));
  });

  it('also rejects a javascript: value preceded by a full-width space or a line break with the reason that the URL cannot be used', () => {
    expect([
      validateLinkUrl('　javascript:alert(1)', LOCALIZER),
      validateLinkUrl('\njavascript:alert(1)', LOCALIZER),
    ]).toEqual(['linkDialog.urlUnsafe', 'linkDialog.urlUnsafe']);
  });

  it('also rejects a mixed-case JavaScript: value with the reason that the URL cannot be used', () => {
    expect(validateLinkUrl('JavaScript:alert(1)', LOCALIZER)).toBe('linkDialog.urlUnsafe');
  });

  it('passes values that contain whitespace or non-ASCII characters', () => {
    expect([
      validateLinkUrl('docs/my file.html', LOCALIZER),
      validateLinkUrl('資料/設計.html', LOCALIZER),
    ]).toEqual([undefined, undefined]);
  });
});

describe('applying the dialog result', () => {
  it('calls neither the format command port nor the insertion port when there is no selection at confirm time', () => {
    const root = mountRoot('<p>abcd</p>');
    window.getSelection()?.removeAllRanges();
    const { ports, operations, inserted } = createPorts(root);

    applyLinkDialogResult(ports, { confirmed: true, values: { url: 'https://example.test/' } });

    expect([operations, inserted]).toEqual([[], []]);
  });
});
