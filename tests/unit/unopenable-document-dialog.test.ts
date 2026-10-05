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

// Use a catalog with short values because this test checks which message is selected for each
// reason, not the wording itself.
const localizer: Localizer = createLocalizer({
  'unopenableDocument.heading': HEADING,
  'unopenableDocument.condition': CONDITION,
  'unopenableDocument.forbiddenTag': FORBIDDEN_TAG,
  'unopenableDocument.encodingMismatch': ENCODING_MISMATCH,
  'unopenableDocument.openInTextEditor': OPEN_IN_TEXT_EDITOR,
});

// Button presses are not verified in this file. The result of a press, including the send to the host, is checked in
// the E2E layer.
const ignoreSwitchRequest = (): void => undefined;

function build(reason: UnopenableReason): ReturnType<typeof buildUnopenableDocumentOverlay> {
  return buildUnopenableDocumentOverlay(localizer, reason, ignoreSwitchRequest);
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

  it('offers exactly one switch action whatever the reason', () => {
    expect(build({ kind: 'boundary' }).actions.map((action) => action.label)).toEqual([
      OPEN_IN_TEXT_EDITOR,
    ]);
  });
});
