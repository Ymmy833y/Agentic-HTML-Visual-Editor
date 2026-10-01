import { describe, expect, it } from 'vitest';

import { blockFormSubmission } from '../../webview/document/form-submission';

function buildRootWithForm(): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = '<form action="/submit"><input name="a"><button type="submit">Submit</button></form>';
  blockFormSubmission(root);
  return root;
}

function dispatchSubmit(root: HTMLElement): boolean {
  const form = root.querySelector('form');
  if (form === null) {
    throw new Error('The test input contains no form');
  }
  return form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

describe('form submission blocking', () => {
  it('cancels the default action of a form submit event under the editor root', () => {
    const root = buildRootWithForm();

    expect(dispatchSubmit(root)).toBe(false);
  });

  it('cancels each submit event once after being called twice for the same editor root', () => {
    const root = buildRootWithForm();
    blockFormSubmission(root);
    const form = root.querySelector('form');
    if (form === null) {
      throw new Error('The test input contains no form');
    }

    const event = new Event('submit', { bubbles: true, cancelable: true });
    let cancellations = 0;
    const cancel = event.preventDefault.bind(event);
    event.preventDefault = (): void => {
      cancellations += 1;
      cancel();
    };
    form.dispatchEvent(event);

    expect(cancellations).toBe(1);
  });

  it('keeps the form and its controls in the tree after canceling submission', () => {
    const root = buildRootWithForm();
    dispatchSubmit(root);

    expect(root.querySelectorAll('form, input, button')).toHaveLength(3);
  });
});
