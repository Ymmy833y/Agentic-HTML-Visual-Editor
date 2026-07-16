// Modal dialog for inserting an image. This follows the link-dialog behavior:
// the VS Code webview cannot use window.prompt(), so the form is rendered in
// the DOM and resolves asynchronously after Insert or Cancel.

import { validateImageSource } from '../commands/image';

export type ImageDialogResult =
  | { action: 'insert'; source: string; alt: string }
  | { action: 'cancel' };

export function openImageDialog(): Promise<ImageDialogResult> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'ahve-dialog-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'ahve-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', 'Insert image');

    const title = document.createElement('div');
    title.className = 'ahve-dialog-title';
    title.textContent = 'Insert image';

    const sourceLabel = document.createElement('label');
    sourceLabel.className = 'ahve-dialog-label';
    sourceLabel.textContent = 'Image path or URL';

    const sourceInput = document.createElement('input');
    sourceInput.type = 'text';
    sourceInput.id = 'ahve-image-source';
    sourceInput.className = 'ahve-dialog-input';
    sourceInput.placeholder = './images/photo.png or https://';
    sourceInput.setAttribute('aria-describedby', 'ahve-image-source-error');
    sourceLabel.appendChild(sourceInput);

    const altLabel = document.createElement('label');
    altLabel.className = 'ahve-dialog-label';
    altLabel.textContent = 'Alt text (optional)';

    const altInput = document.createElement('input');
    altInput.type = 'text';
    altInput.id = 'ahve-image-alt';
    altInput.className = 'ahve-dialog-input';
    altLabel.appendChild(altInput);

    const error = document.createElement('div');
    error.id = 'ahve-image-source-error';
    error.className = 'ahve-dialog-error';
    error.setAttribute('role', 'alert');
    error.hidden = true;

    const actions = document.createElement('div');
    actions.className = 'ahve-dialog-actions';

    const finish = (result: ImageDialogResult): void => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(result);
    };

    const submit = (): void => {
      const validation = validateImageSource(sourceInput.value);
      if (!validation.valid) {
        sourceInput.setAttribute('aria-invalid', 'true');
        error.textContent = validation.message;
        error.hidden = false;
        sourceInput.focus();
        return;
      }
      finish({
        action: 'insert',
        source: validation.source,
        alt: altInput.value.trim(),
      });
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

    sourceInput.addEventListener('input', () => {
      sourceInput.removeAttribute('aria-invalid');
      error.hidden = true;
      error.textContent = '';
    });

    const spacer = document.createElement('span');
    spacer.style.flex = '1';
    actions.append(
      spacer,
      button('Cancel', 'ahve-dialog-btn', () => finish({ action: 'cancel' })),
      button('Insert', 'ahve-dialog-btn ahve-dialog-primary', submit),
    );

    dialog.append(title, sourceLabel, altLabel, error, actions);
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
      sourceInput.focus();
      sourceInput.select();
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
