import { describe, expect, it } from 'vitest';

import {
  CUT_EDIT_KIND,
  handleCopy,
  handleCut,
  readTargetRange,
  writeClipboardContent,
} from '../../webview/editing/clipboard-copy';
import type { ClipboardCopyPorts } from '../../webview/editing/clipboard-copy';
import { createRange, mountRoot, readChildText, readElement, select } from './helpers/format-dom';

/** A stand-in for DataTransfer, which jsdom lacks. Records the written formats and values in writing order. */
class ClipboardDataStub {
  readonly written: [string, string][] = [];

  setData(format: string, data: string): void {
    this.written.push([format, data]);
  }
}

/** The record of port calls and the diagnostics recorded. */
interface PortsRecord {
  readonly calls: string[];
  readonly diagnostics: string[];
}

/** What is passed to the listeners, and its record. */
interface Harness {
  readonly root: HTMLElement;
  readonly data: ClipboardDataStub;
  readonly event: ClipboardEvent;
  readonly record: PortsRecord;
}

/**
 * Creates a clipboard event.
 *
 * @param type The event type.
 * @param clipboardData The clipboard data. `null` makes an event without clipboard data.
 * @returns The event.
 */
function createClipboardEvent(type: 'copy' | 'cut', clipboardData: ClipboardDataStub | null): ClipboardEvent {
  const event = new Event(type, { cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: clipboardData });
  // jsdom lacks ClipboardEvent. The listeners read only clipboardData and default prevention, and this Event has both.
  return event as ClipboardEvent;
}

/**
 * Creates the listener ports.
 *
 * As on the command path, the edit attempt calls the command when opened, closes as aborted if the tree did not change,
 * and aborts and rethrows on an exception. By default, range deletion gets no target block and deletes nothing.
 *
 * @param record The record of calls and diagnostics.
 * @param overrides The ports to replace.
 * @returns The ports.
 */
function createPorts(record: PortsRecord, overrides: Partial<ClipboardCopyPorts> = {}): ClipboardCopyPorts {
  return {
    isComposing: () => false,
    isInputStopped: () => false,
    runCommandEdit: (kind, command) => {
      record.calls.push(`begin:${kind}`);
      try {
        const changed = command();
        record.calls.push(changed ? 'complete' : 'abort');
        return changed;
      } catch (error) {
        record.calls.push('abort');
        throw error;
      }
    },
    deleteRange: () => {
      record.calls.push('deleteRange');
      return undefined;
    },
    reportDiagnostic: (detail) => {
      record.diagnostics.push(detail);
    },
    ...overrides,
  };
}

/**
 * Places a body, selects part of the paragraph's text, and creates an event.
 *
 * @param type The event type.
 * @param tamper Receives the range before it is selected and tampers with it.
 * @returns What is passed to the listeners, and its record.
 */
function prepare(type: 'copy' | 'cut', tamper?: (range: Range) => void): Harness {
  const root = mountRoot('<p>abc</p>');
  const text = readChildText(readElement(root, 'p'), 0);
  const range = createRange(text, 1, text, 2);
  tamper?.(range);
  select(range);
  const data = new ClipboardDataStub();
  return { root, data, event: createClipboardEvent(type, data), record: { calls: [], diagnostics: [] } };
}

/**
 * Lets reading the selection and the target check pass, but throws on the common ancestor that HTML creation reads to
 * clone.
 *
 * @param range The range to select.
 */
function breakCommonAncestor(range: Range): void {
  Object.defineProperty(range, 'commonAncestorContainer', {
    get: () => {
      throw new Error('Cannot read the range');
    },
  });
}

describe('handling copy', () => {
  it('writes both forms and prevents the default for a target selection, even with ports reporting composition and input stop', () => {
    const root = mountRoot('<p>a <strong>bold</strong></p>');
    const text = readChildText(readElement(root, 'strong'), 0);
    select(createRange(text, 1, text, 3));
    const data = new ClipboardDataStub();
    const event = createClipboardEvent('copy', data);
    const record: PortsRecord = { calls: [], diagnostics: [] };

    handleCopy(event, root, createPorts(record, { isComposing: () => true, isInputStopped: () => true }));

    expect([event.defaultPrevented, data.written])
      .toEqual([true, [['text/html', '<strong>ol</strong>'], ['text/plain', 'ol']]]);
  });

  it('when creating the copy content fails with an exception, prevents the default, writes neither form, and records one diagnostic line', () => {
    const { root, data, event, record } = prepare('copy', breakCommonAncestor);

    handleCopy(event, root, createPorts(record));

    expect([event.defaultPrevented, data.written, record.diagnostics.length]).toEqual([true, [], 1]);
  });

  it('for an event without clipboard data, returns no range and does not prevent the default', () => {
    const { root, record } = prepare('copy');
    const event = createClipboardEvent('copy', null);

    handleCopy(event, root, createPorts(record));

    expect([readTargetRange(root, event), event.defaultPrevented]).toEqual([undefined, false]);
  });
});

describe('handling cut', () => {
  it('during composition, prevents the default, opens no attempt, and writes neither form', () => {
    const { root, data, event, record } = prepare('cut');

    handleCut(event, root, createPorts(record, { isComposing: () => true }));

    expect([event.defaultPrevented, record.calls, data.written]).toEqual([true, [], []]);
  });

  it('while input is stopped, prevents the default, opens no attempt, and writes neither form', () => {
    const { root, data, event, record } = prepare('cut');

    handleCut(event, root, createPorts(record, { isInputStopped: () => true }));

    expect([event.defaultPrevented, record.calls, data.written]).toEqual([true, [], []]);
  });

  it('when the attempt cannot be opened, does not call range deletion, prevents the default, and writes neither form', () => {
    const { root, data, event, record } = prepare('cut');
    const ports = createPorts(record, {
      runCommandEdit: (kind) => {
        record.calls.push(`refused:${kind}`);
        return false;
      },
    });

    handleCut(event, root, ports);

    expect([event.defaultPrevented, record.calls, data.written]).toEqual([true, [`refused:${CUT_EDIT_KIND}`], []]);
  });

  it('when range deletion returns no target block, the attempt closes as aborted and neither form is written', () => {
    const { root, data, event, record } = prepare('cut');

    handleCut(event, root, createPorts(record));

    expect([event.defaultPrevented, record.calls, data.written])
      .toEqual([true, [`begin:${CUT_EDIT_KIND}`, 'deleteRange', 'abort'], []]);
  });

  it('when range deletion returns a target block but does not change the tree, the attempt closes as aborted and neither form is written', () => {
    const { root, data, event, record } = prepare('cut');
    const ports = createPorts(record, {
      deleteRange: () => {
        record.calls.push('deleteRange');
        return readElement(root, 'p');
      },
    });

    handleCut(event, root, ports);

    expect([event.defaultPrevented, record.calls, data.written])
      .toEqual([true, [`begin:${CUT_EDIT_KIND}`, 'deleteRange', 'abort'], []]);
  });

  it('when range deletion throws, does not let it escape, records one diagnostic line, prevents the default, and writes neither form', () => {
    const { root, data, event, record } = prepare('cut');
    const ports = createPorts(record, {
      deleteRange: () => {
        throw new Error('Cannot delete');
      },
    });

    handleCut(event, root, ports);

    expect([event.defaultPrevented, record.calls, data.written, record.diagnostics.length])
      .toEqual([true, [`begin:${CUT_EDIT_KIND}`, 'abort'], [], 1]);
  });

  it('when creating the copy content fails with an exception, opens no attempt, prevents the default, and writes neither form', () => {
    const { root, data, event, record } = prepare('cut', breakCommonAncestor);

    handleCut(event, root, createPorts(record));

    expect([event.defaultPrevented, record.calls, data.written]).toEqual([true, [], []]);
  });
});

describe('writing the copy content', () => {
  it('writes two empty forms and prevents the default even when the copy content is empty', () => {
    const data = new ClipboardDataStub();
    const event = createClipboardEvent('copy', data);

    writeClipboardContent(event, { html: '', text: '' });

    expect([event.defaultPrevented, data.written]).toEqual([true, [['text/html', ''], ['text/plain', '']]]);
  });
});
