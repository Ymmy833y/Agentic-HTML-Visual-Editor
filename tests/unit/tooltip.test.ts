import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EDITOR_ROOT_ELEMENT_ID } from '../../common/index';
import { TOOLTIP_DELAY_MS, TooltipController, hasTitleAncestor } from '../../webview/ui/tooltip';

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

describe('the resolver scope', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.replaceChildren();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('the resolver answers for a target inside an added scope, and not for one outside the editor root and the scopes', () => {
    const controller = createController();
    const scope = document.createElement('div');
    const inside = document.createElement('a');
    scope.append(inside);
    const outside = document.createElement('a');
    document.body.append(scope, outside);
    controller.registerResolver(() => 'Follow link');
    controller.addResolverScope(scope);

    const shown: (string | null | undefined)[] = [];
    for (const target of [outside, inside]) {
      target.dispatchEvent(new Event('pointerover', { bubbles: true }));
      vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
      shown.push(document.querySelector('[role="tooltip"]')?.textContent);
    }

    expect(shown).toEqual([undefined, 'Follow link']);
  });
});

describe('a press on the tooltip', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.replaceChildren();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is over when it is cancelled, so that a later focus move still hides the tooltip', () => {
    const controller = createController();
    controller.attachFocusTrigger();
    const first = document.createElement('button');
    const second = document.createElement('button');
    document.body.append(first, second);
    controller.registerTarget(first, 'Save');
    controller.registerTarget(second, 'Bold');
    first.dispatchEvent(new Event('pointerover', { bubbles: true }));
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    const tooltip = document.querySelector('[role="tooltip"]');
    // Dragging the selected text away ends the press with a cancel instead of a release, and the pointer then leaves.
    tooltip?.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    tooltip?.dispatchEvent(new Event('pointercancel', { bubbles: true }));
    tooltip?.dispatchEvent(new Event('pointerout', { bubbles: true }));
    second.dispatchEvent(new Event('pointerover', { bubbles: true }));
    vi.advanceTimersByTime(TOOLTIP_DELAY_MS);

    document.getElementById(EDITOR_ROOT_ELEMENT_ID)?.dispatchEvent(new Event('focusout', { bubbles: true }));

    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });
});
