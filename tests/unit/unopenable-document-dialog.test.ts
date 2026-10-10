import { describe, expect, it } from 'vitest';

import { createLocalizer } from '../../common/index';
import type { Localizer } from '../../common/index';
import { buildUnopenableDocumentOverlay } from '../../webview/ui/unopenable-document-dialog';
import type { UnopenableReason } from '../../webview/ui/unopenable-document-dialog';

const HEADING = 'Cannot Open';
const CONDITION = 'These are the opening conditions';
const FORBIDDEN_TAG = 'The body contains <{tagName}>';
const ENCODING_MISMATCH = 'Reopen it with the right encoding';
const OPEN_IN_TEXT_EDITOR = 'Switch to text';
const CREATE_SKELETON = 'Create a skeleton';

// Use a catalog with short values because this test checks which message is selected for each
// reason, not the wording itself.
const localizer: Localizer = createLocalizer({
  'unopenableDocument.heading': HEADING,
  'unopenableDocument.condition': CONDITION,
  'unopenableDocument.forbiddenTag': FORBIDDEN_TAG,
  'unopenableDocument.encodingMismatch': ENCODING_MISMATCH,
  'unopenableDocument.openInTextEditor': OPEN_IN_TEXT_EDITOR,
  'unopenableDocument.createSkeleton': CREATE_SKELETON,
});

// Only the skeleton button's press is verified in this file. The send to the host that a press leads to is checked in
// the E2E layer.
const ignoreRequest = (): void => undefined;

function build(reason: UnopenableReason): ReturnType<typeof buildUnopenableDocumentOverlay> {
  return buildUnopenableDocumentOverlay(localizer, reason, ignoreRequest, ignoreRequest);
}

describe('the content of the unopenable document overlay', () => {
  it('describes what makes a document openable when the boundary could not be established', () => {
    expect(build({ kind: 'boundary' }).descriptions).toEqual([CONDITION]);
  });

  it('includes the detected tag name in the description for a forbidden tag', () => {
    expect(build({ kind: 'forbiddenTag', tagName: 'script' }).descriptions).toEqual([
      'The body contains <script>',
    ]);
  });

  it('describes how to choose the encoding again when the text was decoded with a mismatched encoding', () => {
    expect(build({ kind: 'encodingMismatch' }).descriptions).toEqual([ENCODING_MISMATCH]);
  });

  it('uses the same heading for either reason', () => {
    expect(build({ kind: 'forbiddenTag', tagName: 'script' }).heading).toBe(
      build({ kind: 'boundary' }).heading,
    );
  });

  it('offers exactly one switch action when the boundary could not be established', () => {
    expect(build({ kind: 'boundary' }).actions.map((action) => action.label)).toEqual([
      OPEN_IN_TEXT_EDITOR,
    ]);
  });

  it('offers the skeleton action before the switch action for a blank document', () => {
    expect(build({ kind: 'blank' }).actions.map((action) => action.label)).toEqual([
      CREATE_SKELETON,
      OPEN_IN_TEXT_EDITOR,
    ]);
  });

  it('calls the skeleton receiver once for each press of the skeleton action', () => {
    let requests = 0;
    const overlay = buildUnopenableDocumentOverlay(localizer, { kind: 'blank' }, ignoreRequest, () => {
      requests += 1;
    });

    overlay.actions[0].run();
    overlay.actions[0].run();

    expect(requests).toBe(2);
  });

  it.each<UnopenableReason>([
    { kind: 'boundary' },
    { kind: 'forbiddenTag', tagName: 'script' },
    { kind: 'encodingMismatch' },
  ])('offers no skeleton action when the reason is $kind', (reason) => {
    expect(build(reason).actions.map((action) => action.label)).not.toContain(CREATE_SKELETON);
  });
});
