import { beforeEach, describe, expect, it } from 'vitest';

import { EDITOR_ROOT_ELEMENT_ID } from '../../common/index';
import { TooltipController, hasTitleAncestor } from '../../webview/ui/tooltip';

/** Attaches the tooltip controller to a document with an editor root. */
function createController(): TooltipController {
  document.body.replaceChildren();
  const root = document.createElement('div');
  root.id = EDITOR_ROOT_ELEMENT_ID;
  document.body.append(root);
  return new TooltipController(window);
}

describe('the tooltip target', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('shows nothing for a target whose message is empty', () => {
    const controller = createController();
    const target = document.createElement('button');
    document.body.append(target);

    controller.registerTarget(target, '');
    target.dispatchEvent(new Event('pointerover', { bubbles: true }));

    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });

  it('sets no title on a UI component', () => {
    const controller = createController();
    const target = document.createElement('button');
    document.body.append(target);

    controller.registerTarget(target, 'Save');

    expect(target.hasAttribute('title')).toBe(false);
  });

  it('can be hidden safely while nothing is shown', () => {
    const controller = createController();

    expect(() => controller.hide()).not.toThrow();
  });
});

describe('deciding whether a target has the built-in display', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('decides that a target has one when an ancestor within the editor root has a title', () => {
    createController();
    const root = document.getElementById(EDITOR_ROOT_ELEMENT_ID);
    const paragraph = document.createElement('p');
    paragraph.title = 'A note';
    const link = document.createElement('a');
    paragraph.append(link);
    root?.append(paragraph);

    expect(hasTitleAncestor(link)).toBe(true);
  });

  it('decides that a target with no title does not have one', () => {
    createController();
    const root = document.getElementById(EDITOR_ROOT_ELEMENT_ID);
    const link = document.createElement('a');
    root?.append(link);

    expect(hasTitleAncestor(link)).toBe(false);
  });
});
