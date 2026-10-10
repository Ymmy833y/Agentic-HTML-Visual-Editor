import { beforeEach, describe, expect, it } from 'vitest';

import { MESSAGE_CATALOG_ELEMENT_ID } from '../../common/index';
import { readEmbeddedCatalog } from '../../webview/i18n/embedded-catalog';

describe('reading an embedded message catalog', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('reads the contents of the element with the default id as a catalog', () => {
    const element = document.createElement('script');
    element.type = 'application/json';
    element.id = MESSAGE_CATALOG_ELEMENT_ID;
    element.textContent = '{"greeting":"Hello"}';
    document.body.append(element);

    expect(readEmbeddedCatalog(document)).toEqual({ greeting: 'Hello' });
  });

  it('returns an empty catalog when the element with the default id is absent', () => {
    expect(readEmbeddedCatalog(document)).toEqual({});
  });

  it('returns an empty catalog without throwing when the element content is invalid', () => {
    const element = document.createElement('script');
    element.type = 'application/json';
    element.id = MESSAGE_CATALOG_ELEMENT_ID;
    element.textContent = '{';
    document.body.append(element);

    expect(readEmbeddedCatalog(document)).toEqual({});
  });
});
