import { describe, expect, it } from 'vitest';

import { createLocalizer } from '../../common/index';
import type { ShortcutPlatform } from '../../webview/editing/shortcut-receiver';
import { attachLinkClick, createLinkTooltipResolver, findLink } from '../../webview/ui/link-follow';
import type { LinkClickPorts } from '../../webview/ui/link-follow';
import { mountRoot, readElement } from './helpers/format-dom';

// A body with one link whose href is a relative file href.
const RELATIVE_LINK_BODY = '<p><a href="docs/a.html">ab</a></p>';

/** The outcome of one click. */
interface ClickOutcome {
  /** Whether the default action was prevented. */
  readonly prevented: boolean;
  /** Whether the click reached the document. */
  readonly reached: boolean;
}

/** The editor root with the link click dispatch attached, and the records of the requests sent and diagnostics. */
interface ClickHarness {
  readonly root: HTMLElement;
  readonly posted: string[];
  readonly diagnostics: string[];
}

/**
 * Places the body and attaches the link click dispatch.
 *
 * @param body The contents of the editor root.
 * @param platform The shortcut platform.
 * @param postRelativeLink The port that sends requests. By default it records the href sent.
 * @returns The editor root and the records.
 */
function attach(
  body: string,
  platform: ShortcutPlatform,
  postRelativeLink?: LinkClickPorts['postRelativeLink'],
): ClickHarness {
  const root = mountRoot(body);
  const posted: string[] = [];
  const diagnostics: string[] = [];
  attachLinkClick(root, platform, {
    postRelativeLink: postRelativeLink ?? ((href) => posted.push(href)),
    reportDiagnostic: (detail) => diagnostics.push(detail),
  });
  return { root, posted, diagnostics };
}

/**
 * Dispatches a click to an element and returns whether the default action was prevented and whether the click
 * reached the document.
 *
 * On the document, a double of VS Code's click handling receives it. The double notes whether the default action
 * had been prevented when the click arrived, and prevents the default action like the real handling. Otherwise
 * jsdom would try to follow the link.
 *
 * @param element The element to click.
 * @param init The modifiers and button of the click.
 * @returns The outcome of the click.
 */
function click(element: Element, init: MouseEventInit): ClickOutcome {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, ...init });
  let arrived: ClickOutcome | undefined;
  const stand = (received: Event): void => {
    arrived = { prevented: received.defaultPrevented, reached: true };
    received.preventDefault();
  };
  document.addEventListener('click', stand);
  element.dispatchEvent(event);
  document.removeEventListener('click', stand);
  return arrived ?? { prevented: event.defaultPrevented, reached: false };
}

describe('checking the primary modifier', () => {
  it('sends a request for a click with Meta on mac, and for a click with Ctrl stops the default action and propagation without sending', () => {
    const harness = attach(RELATIVE_LINK_BODY, 'mac');
    const link = readElement(harness.root, 'a');

    click(link, { metaKey: true });
    const control = click(link, { ctrlKey: true });

    expect([harness.posted, control]).toEqual([['docs/a.html'], { prevented: true, reached: false }]);
  });

  it('stops the default action and propagation of a click with Meta without sending when the platform is not mac', () => {
    const harness = attach(RELATIVE_LINK_BODY, 'other');

    const meta = click(readElement(harness.root, 'a'), { metaKey: true });

    expect([harness.posted, meta]).toEqual([[], { prevented: true, reached: false }]);
  });
});

describe('dispatching link clicks', () => {
  it('stops neither the default action nor propagation and sends no request for a click with a button other than the primary one', () => {
    const harness = attach(RELATIVE_LINK_BODY, 'other');

    const middle = click(readElement(harness.root, 'a'), { button: 1, ctrlKey: true });

    expect([harness.posted, middle]).toEqual([[], { prevented: false, reached: true }]);
  });

  it('does not throw, leaves one diagnostic line and keeps the default action and propagation stopped when the port that sends requests throws', () => {
    const harness = attach(RELATIVE_LINK_BODY, 'other', () => {
      throw new Error('Cannot send');
    });

    const outcome = click(readElement(harness.root, 'a'), { ctrlKey: true });

    expect([harness.diagnostics.length, outcome]).toEqual([1, { prevented: true, reached: false }]);
  });
});

describe('finding a link', () => {
  it('returns nothing inside an a without an href and for an a outside the editor root', () => {
    const root = mountRoot('<p><a name="anchor">ab</a></p>');
    const outside = document.createElement('a');
    outside.href = 'docs/a.html';
    document.body.append(outside);

    expect([findLink(readElement(root, 'a'), root), findLink(outside, root)]).toEqual([undefined, undefined]);
  });
});

describe('the hover tooltip message', () => {
  it('returns the linkFollow.hint.mac message on mac and the linkFollow.hint.other message otherwise', () => {
    const root = mountRoot(RELATIVE_LINK_BODY);
    const link = readElement(root, 'a');
    const localizer = createLocalizer({});

    expect([
      createLinkTooltipResolver(root, 'mac', localizer)(link),
      createLinkTooltipResolver(root, 'other', localizer)(link),
    ]).toEqual([
      { owner: link, label: 'linkFollow.hint.mac' },
      { owner: link, label: 'linkFollow.hint.other' },
    ]);
  });

  it('returns the link as the tooltip target when given an element inside the link', () => {
    const root = mountRoot('<p><a href="docs/a.html">a<strong>b</strong></a></p>');
    const resolve = createLinkTooltipResolver(root, 'other', createLocalizer({}));

    const resolved = resolve(readElement(root, 'strong'));

    expect(typeof resolved === 'object' && resolved.owner === readElement(root, 'a')).toBe(true);
  });
});
