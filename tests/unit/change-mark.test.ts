// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  ALLOWED_TAG_NAMES,
  CHANGE_ATTRIBUTE,
  CHANGE_AUTHOR,
  CHANGE_KIND,
  COMMENT_ATTRIBUTE,
  COMMENT_AUTHOR,
} from '../../common/index';

describe('change mark definitions', () => {
  it('lists the two kinds as the element names ins and del', () => {
    expect(Object.values(CHANGE_KIND)).toEqual(['ins', 'del']);
  });

  it('includes both inline mark elements in the allowed tag list', () => {
    expect(Object.values(CHANGE_KIND).filter((name) => !ALLOWED_TAG_NAMES.has(name))).toEqual([]);
  });

  it('marks an element that cannot be wrapped with data-change', () => {
    expect(CHANGE_ATTRIBUTE.kind).toBe('data-change');
  });

  it('spells the author and update time attributes the same as comment entries', () => {
    expect([CHANGE_ATTRIBUTE.author, CHANGE_ATTRIBUTE.updated])
      .toEqual([COMMENT_ATTRIBUTE.author, COMMENT_ATTRIBUTE.updated]);
  });

  it('takes the same two author labels as comment entries', () => {
    expect(CHANGE_AUTHOR).toBe(COMMENT_AUTHOR);
  });
});
