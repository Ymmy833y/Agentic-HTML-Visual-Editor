// Modal dialog for inserting or editing a hyperlink. The VSCode webview
// sandbox blocks window.prompt(), so we render our own dialog in the DOM.

export type LinkDialogResult =
  | { action: 'set'; url: string }
  | { action: 'remove' }
  | { action: 'cancel' };

export function openLinkDialog(currentUrl: string): Promise<LinkDialogResult> {
  return new Promise((resolve) => {
    const editing = currentUrl.length > 0;

    const overlay = document.createElement('div');
    overlay.className = 'ahve-dialog-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'ahve-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', editing ? 'Edit link' : 'Insert link');

    const title = document.createElement('div');
    title.className = 'ahve-dialog-title';
    title.textContent = editing ? 'Edit link' : 'Insert link';

    const label = document.createElement('label');
    label.className = 'ahve-dialog-label';
    label.textContent = 'URL';

    const input = document.createElement('input');
    input.type = 'url';
    input.className = 'ahve-dialog-input';
    input.value = currentUrl;
    input.placeholder = 'https://';
    label.appendChild(input);

    const actions = document.createElement('div');
    actions.className = 'ahve-dialog-actions';

    const finish = (result: LinkDialogResult): void => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(result);
    };

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish({ action: 'cancel' });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        submit();
      }
    };

    const submit = (): void => {
      const value = input.value.trim();
      if (value === '') {
        finish(editing ? { action: 'remove' } : { action: 'cancel' });
        return;
      }
      finish({ action: 'set', url: value });
    };

    if (editing) {
      actions.appendChild(
        button('Remove link', 'ahve-dialog-btn ahve-dialog-danger', () =>
          finish({ action: 'remove' }),
        ),
      );
      const spacer = document.createElement('span');
      spacer.style.flex = '1';
      actions.appendChild(spacer);
    }
    actions.appendChild(
      button('Cancel', 'ahve-dialog-btn', () => finish({ action: 'cancel' })),
    );
    actions.appendChild(
      button(editing ? 'Update' : 'Insert', 'ahve-dialog-btn ahve-dialog-primary', submit),
    );

    dialog.appendChild(title);
    dialog.appendChild(label);
    dialog.appendChild(actions);
    overlay.appendChild(dialog);

    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) {
        e.preventDefault();
        finish({ action: 'cancel' });
      }
    });

    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey, true);
    queueMicrotask(() => {
      input.focus();
      input.select();
    });
  });
}

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}
