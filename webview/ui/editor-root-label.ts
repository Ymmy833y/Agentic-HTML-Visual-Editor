import type { Localizer } from '../../common/index';

/** The ID of the element that holds the editor root's name. */
export const EDITOR_ROOT_LABEL_ELEMENT_ID = 'editor-root-label';

/**
 * Marks the editor root as a multi-line editable region and gives it a name.
 *
 * The name is taken from a hidden element placed outside the editor root. The editor root carries
 * the language declaration of the opened document, so writing the name string in an attribute of
 * the editor root would have it read in the document's language. The element outside inherits the
 * language declaration of the view's root (the UI language), and does not appear in the body output
 * either.
 *
 * Called once, on the first mount. The editor root stays the same element across document
 * replacements, so this is not applied again.
 *
 * @param root The editor root.
 * @param localizer The localizer.
 */
export function labelEditorRoot(root: HTMLElement, localizer: Localizer): void {
  const label = root.ownerDocument.createElement('div');
  label.id = EDITOR_ROOT_LABEL_ELEMENT_ID;
  label.hidden = true;
  label.textContent = localizer.getMessage('editorRoot.name');
  root.after(label);

  root.setAttribute('role', 'textbox');
  root.setAttribute('aria-multiline', 'true');
  root.setAttribute('aria-labelledby', EDITOR_ROOT_LABEL_ELEMENT_ID);
}
