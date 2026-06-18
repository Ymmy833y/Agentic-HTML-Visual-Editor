// Modal confirmation dialog. The VSCode webview sandbox blocks window.confirm(),
// so we render our own dialog reusing the shared `.ahve-dialog-*` styles. Used to
// guard edits/deletes of comment content authored by the counterpart (AI).

export interface ConfirmDialogOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Render the confirm button as a destructive (danger) action. */
  danger?: boolean;
}

export function openConfirmDialog(options: ConfirmDialogOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'ahve-dialog-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'ahve-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', options.title ?? 'Confirm');

    const title = document.createElement('div');
    title.className = 'ahve-dialog-title';
    title.textContent = options.title ?? 'Confirm';

    const message = document.createElement('div');
    message.className = 'ahve-dialog-message';
    message.textContent = options.message;

    const actions = document.createElement('div');
    actions.className = 'ahve-dialog-actions';

    const finish = (result: boolean): void => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(result);
    };

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish(false);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        finish(true);
      }
    };

    const spacer = document.createElement('span');
    spacer.style.flex = '1';
    const confirmClass = options.danger
      ? 'ahve-dialog-btn ahve-dialog-danger'
      : 'ahve-dialog-btn ahve-dialog-primary';
    actions.append(
      spacer,
      button(options.cancelLabel ?? 'Cancel', 'ahve-dialog-btn', () => finish(false)),
      button(options.confirmLabel ?? 'OK', confirmClass, () => finish(true)),
    );

    dialog.append(title, message, actions);
    overlay.appendChild(dialog);

    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) {
        e.preventDefault();
        finish(false);
      }
    });

    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey, true);
    queueMicrotask(() => {
      const confirmBtn = actions.lastElementChild;
      if (confirmBtn instanceof HTMLElement) confirmBtn.focus();
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
