import { afterEach, describe, expect, it, vi } from 'vitest';

import { VIEW_TO_HOST_MESSAGE_TYPE } from '../../common/index';
import { createCopyHtmlResponse } from '../../webview/editing/copy-html-response';
import { mountRoot } from './helpers/format-dom';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('creating the copy HTML response', () => {
  it('creates a response with the same request id and a null html when there is no editor root', () => {
    expect(createCopyHtmlResponse('7', undefined, () => undefined)).toEqual({
      type: VIEW_TO_HOST_MESSAGE_TYPE.copyHtmlResponse,
      requestId: '7',
      html: null,
    });
  });

  it('creates a response with a null html when creating the copy content returns a failure', () => {
    const root = mountRoot('<p>abc</p>');
    // Creation returns a failure when it cannot create the inert document that the range is copied into.
    vi.spyOn(document.implementation, 'createHTMLDocument').mockImplementation(() => {
      throw new Error('cannot create the inert document');
    });

    expect(createCopyHtmlResponse('1', root, () => undefined).html).toBeNull();
  });

  it('does not rethrow when reading the selection throws, leaves one diagnostic line, and creates a response with a null html', () => {
    const root = mountRoot('<p>abc</p>');
    vi.spyOn(window, 'getSelection').mockImplementation(() => {
      throw new Error('cannot read the selection');
    });
    const diagnostics: string[] = [];

    const response = createCopyHtmlResponse('1', root, (detail) => diagnostics.push(detail));

    expect([response.html, diagnostics.length]).toEqual([null, 1]);
  });
});
