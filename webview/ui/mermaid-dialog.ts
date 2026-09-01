// Modal source editor for an existing or new Mermaid diagram. Applying an invalid
// draft is allowed: the source remains the document's truth and the diagram
// surface reports the render error without losing the draft.

export type MermaidDialogResult =
  | { action: 'apply'; source: string }
  | { action: 'delete' }
  | { action: 'cancel' };

export interface MermaidDialogOptions {
  allowDelete?: boolean;
}

export function openMermaidDialog(
  initialSource: string,
  options: MermaidDialogOptions = {},
): Promise<MermaidDialogResult> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'ahve-dialog-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'ahve-dialog ahve-mermaid-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', 'Edit Mermaid diagram');

    const title = document.createElement('div');
    title.className = 'ahve-dialog-title';
    title.textContent = 'Edit Mermaid diagram';

    const label = document.createElement('label');
    label.className = 'ahve-dialog-label';
    label.textContent = 'Mermaid source';

    const textarea = document.createElement('textarea');
    textarea.id = 'ahve-mermaid-source-input';
    textarea.className = 'ahve-dialog-input ahve-mermaid-source-input';
    textarea.value = initialSource;
    textarea.spellcheck = false;
    label.appendChild(textarea);

    const hint = document.createElement('div');
    hint.className = 'ahve-dialog-message ahve-mermaid-dialog-hint';
    hint.textContent = 'Apply with Ctrl+Enter (Cmd+Enter on macOS).';

    const actions = document.createElement('div');
    actions.className = 'ahve-dialog-actions';

    const finish = (result: MermaidDialogResult): void => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(result);
    };

    const apply = (): void => finish({ action: 'apply', source: textarea.value });

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        finish({ action: 'cancel' });
      } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        event.stopPropagation();
        apply();
      }
    };

    const spacer = document.createElement('span');
    spacer.style.flex = '1';
    if (options.allowDelete !== false) {
      actions.appendChild(
        button('Delete diagram', 'ahve-dialog-btn ahve-dialog-danger', () =>
          finish({ action: 'delete' }),
        ),
      );
    }
    actions.append(
      spacer,
      button('Cancel', 'ahve-dialog-btn', () => finish({ action: 'cancel' })),
      button('Apply', 'ahve-dialog-btn ahve-dialog-primary', apply),
    );

    dialog.append(title, label, hint, actions);
    overlay.appendChild(dialog);
    overlay.addEventListener('mousedown', (event) => {
      if (event.target === overlay) {
        event.preventDefault();
        finish({ action: 'cancel' });
      }
    });

    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey, true);
    queueMicrotask(() => {
      textarea.focus();
      textarea.setSelectionRange(0, textarea.value.length);
    });
  });
}

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = className;
  element.textContent = label;
  element.addEventListener('click', onClick);
  return element;
}
