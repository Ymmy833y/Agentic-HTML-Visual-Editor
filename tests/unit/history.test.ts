import { afterEach, describe, expect, it, vi } from 'vitest';
import { HistoryCoordinator, type HistoryEdit } from '../../webview/core/history';

describe('HistoryCoordinator', () => {
  afterEach(() => vi.useRealTimers());

  it('groups contiguous typing into one transaction', () => {
    vi.useFakeTimers();
    let html = '<p></p>';
    const edits: HistoryEdit[] = [];
    const history = new HistoryCoordinator(
      () => ({ html, selection: null }),
      (edit) => edits.push(edit),
    );
    history.reset();

    html = '<p>a</p>';
    history.recordNative('insertText');
    html = '<p>ab</p>';
    history.recordNative('insertText');
    html = '<p>abc</p>';
    history.recordNative('insertText');
    vi.advanceTimersByTime(1000);

    expect(edits).toHaveLength(1);
    expect(edits[0].before.html).toBe('<p></p>');
    expect(edits[0].after.html).toBe('<p>abc</p>');
  });

  it('commits each direct DOM command as a separate transaction', () => {
    let html = '<p>base</p>';
    const edits: HistoryEdit[] = [];
    const history = new HistoryCoordinator(
      () => ({ html, selection: null }),
      (edit) => edits.push(edit),
    );
    history.reset();

    html = '<p>base</p><p>paste</p>';
    history.recordCommand('Paste');
    html = '<p>base</p><p>paste</p><p>paste</p>';
    history.recordCommand('Paste');

    expect(edits).toHaveLength(2);
    expect(edits[0].after.html).toBe(edits[1].before.html);
  });

  it('flushes pending typing before a following command', () => {
    let html = '<p></p>';
    const edits: HistoryEdit[] = [];
    const history = new HistoryCoordinator(
      () => ({ html, selection: null }),
      (edit) => edits.push(edit),
    );
    history.reset();

    html = '<p>#</p>';
    history.recordNative('insertText');
    html = '<h1></h1>';
    history.recordCommand('Format block');

    expect(edits.map((edit) => [edit.before.html, edit.after.html])).toEqual([
      ['<p></p>', '<p>#</p>'],
      ['<p>#</p>', '<h1></h1>'],
    ]);
  });
});
