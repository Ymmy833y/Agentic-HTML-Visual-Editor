import { describe, expect, it } from 'vitest';

import { TRANSACTION_IDLE_MS } from '../../webview/history/edit-grouping';
import { CommentFieldHistory } from '../../webview/ui/comment-field-history';
import type { CommentFieldHistoryRoute } from '../../webview/ui/comment-field-history';

interface Snapshot {
  readonly key: string;
}

/** A field reduced to its text, with a clock the test moves. */
class FakeField {
  text = '';
  time = 0;
  readonly history = new CommentFieldHistory<Snapshot>(() => this.time);

  /**
   * Runs one edit that sets the text.
   *
   * @param kind The edit kind.
   * @param text The text after the edit.
   */
  edit(kind: string, text: string): void {
    this.history.begin(kind, () => ({ key: this.text }), () => ({ key: this.text }));
    this.text = text;
    this.history.end();
  }
}

/**
 * Reduces a route to what the field returns to, or where the key goes.
 *
 * @param route The route.
 * @returns The text the field returns to, or the kind of the route.
 */
function describeRoute(route: CommentFieldHistoryRoute<Snapshot>): string {
  return route.kind === 'field' ? `field:${route.snapshot.key}` : route.kind;
}

describe('grouping edits in a comment field', () => {
  it('joins edits of the same kind within the idle timeout, and splits them on a change of kind', () => {
    const field = new FakeField();
    field.edit('insertText', 'a');
    field.edit('insertText', 'ab');
    field.edit('deleteContentBackward', 'a');

    expect([describeRoute(field.history.undo()), describeRoute(field.history.undo())]).toEqual(['field:ab', 'field:']);
  });

  it('splits edits of the same kind once the idle timeout has passed', () => {
    const field = new FakeField();
    field.edit('insertText', 'a');
    field.time += TRANSACTION_IDLE_MS;
    field.edit('insertText', 'ab');

    expect(describeRoute(field.history.undo())).toBe('field:a');
  });

  it('records nothing for an edit that left the content as it was', () => {
    const field = new FakeField();
    field.edit('formatBold', '');

    expect(describeRoute(field.history.undo())).toBe('document');
  });

  it('makes an edit opened inside another part of the outer one', () => {
    const field = new FakeField();
    field.history.begin('insertParagraph', () => ({ key: field.text }), () => ({ key: field.text }));
    field.edit('insertText', 'inner');
    field.text = 'inner and outer';
    field.history.end();

    expect([describeRoute(field.history.undo()), describeRoute(field.history.undo())]).toEqual(['field:', 'document']);
  });
});

describe('where undo and redo go from a comment field', () => {
  it('lets undo through to the document once the draft is back where writing started, and redo retraces it', () => {
    const field = new FakeField();
    field.edit('insertText', 'a');

    const routes = [
      field.history.undo(),
      field.history.undo(),
      field.history.redo(),
      field.history.redo(),
      field.history.redo(),
    ].map(describeRoute);

    expect(routes).toEqual(['field:', 'document', 'document', 'field:a', 'none']);
  });

  it('drops the redo and the undos let through to the document on a new edit', () => {
    const field = new FakeField();
    field.edit('insertText', 'a');
    field.history.undo();
    field.history.undo();
    field.edit('insertText', 'b');

    expect(describeRoute(field.history.redo())).toBe('none');
  });

  it('lets undo and redo through to the document after it is reset', () => {
    const field = new FakeField();
    field.edit('insertText', 'a');
    field.history.undo();
    field.history.reset();

    expect([describeRoute(field.history.redo()), describeRoute(field.history.undo())]).toEqual(['document', 'document']);
  });
});
