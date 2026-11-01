import { describe, expect, it, vi } from 'vitest';

import { EditorReturn } from '../../webview/ui/editor-return';

describe('EditorReturn', () => {
  it('returns focus to the editor root without scrolling it into view', () => {
    document.body.replaceChildren();
    const root = document.createElement('div');
    root.contentEditable = 'true';
    document.body.append(root);
    const focus = vi.spyOn(root, 'focus');
    const editorReturn = new EditorReturn(window, {
      readEditorRoot: () => root,
      isEditable: () => true,
      hasViewFocus: () => true,
      isInItemBar: () => false,
      isInSearchPanel: () => false,
      isInSidebar: () => false,
      focusToolbarStop: () => undefined,
    });

    editorReturn.requestReturn();

    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it('returns focus to the field focus was in at the press, with the selection captured from that field', () => {
    document.body.replaceChildren();
    const root = document.createElement('div');
    const field = document.createElement('div');
    const item = document.createElement('button');
    for (const area of [root, field]) {
      area.contentEditable = 'true';
      area.tabIndex = 0;
    }
    root.innerHTML = '<p>document</p>';
    field.innerHTML = '<p>abc</p>';
    document.body.append(root, field, item);
    const editorReturn = new EditorReturn(window, {
      readEditorRoot: () => field,
      isEditable: () => true,
      hasViewFocus: () => true,
      isInItemBar: (node) => node === item,
      isInSearchPanel: () => false,
      isInSidebar: () => false,
      focusToolbarStop: () => undefined,
    });
    editorReturn.attach(root);
    editorReturn.attach(field);
    field.focus();
    const text = field.querySelector('p')?.firstChild;
    if (text === null || text === undefined) {
      throw new Error('the field has no text');
    }
    window.getSelection()?.setBaseAndExtent(text, 1, text, 2);
    item.focus();
    window.getSelection()?.removeAllRanges();

    editorReturn.requestReturn();

    expect([document.activeElement === field, window.getSelection()?.toString()]).toEqual([true, 'b']);
  });

  it('does not put a selection captured from the editor root into a field it returns to afterwards', () => {
    document.body.replaceChildren();
    const root = document.createElement('div');
    const field = document.createElement('div');
    const item = document.createElement('button');
    for (const area of [root, field]) {
      area.contentEditable = 'true';
      area.tabIndex = 0;
    }
    root.innerHTML = '<p>document</p>';
    field.innerHTML = '<p>abc</p>';
    document.body.append(root, field, item);
    let returnTo = root;
    const editorReturn = new EditorReturn(window, {
      readEditorRoot: () => returnTo,
      isEditable: () => true,
      hasViewFocus: () => true,
      isInItemBar: (node) => node === item,
      isInSearchPanel: () => false,
      isInSidebar: () => false,
      focusToolbarStop: () => undefined,
    });
    editorReturn.attach(root);
    editorReturn.attach(field);
    root.focus();
    const text = root.querySelector('p')?.firstChild;
    if (text === null || text === undefined) {
      throw new Error('the editor root has no text');
    }
    window.getSelection()?.setBaseAndExtent(text, 0, text, 3);
    item.focus();
    window.getSelection()?.removeAllRanges();
    returnTo = field;

    editorReturn.requestReturn();

    expect([document.activeElement === field, window.getSelection()?.toString()]).toEqual([true, '']);
  });
});
