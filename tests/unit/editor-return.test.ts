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
});
