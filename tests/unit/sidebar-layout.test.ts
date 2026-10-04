// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { SIDEBAR_MIN_WIDTH, parseSidebarLayout } from '../../common/index';

describe('reading a sidebar layout', () => {
  it('reads the open state alone, and the open state with a width', () => {
    expect([
      parseSidebarLayout({ open: true }),
      parseSidebarLayout({ open: false, width: 240 }),
    ]).toEqual([{ open: true }, { open: false, width: 240 }]);
  });

  it('rounds the width to whole pixels and raises a width below the narrowest width to it', () => {
    expect([
      parseSidebarLayout({ open: true, width: 240.6 }),
      parseSidebarLayout({ open: true, width: SIDEBAR_MIN_WIDTH - 1 }),
      parseSidebarLayout({ open: true, width: -50 }),
    ]).toEqual([
      { open: true, width: 241 },
      { open: true, width: SIDEBAR_MIN_WIDTH },
      { open: true, width: SIDEBAR_MIN_WIDTH },
    ]);
  });

  it('drops fields outside the layout', () => {
    expect(parseSidebarLayout({ open: true, width: 200, extra: 'x' })).toEqual({ open: true, width: 200 });
  });

  it('rejects a value that is not an object, an open state that is not a boolean, and a width that is not a finite number', () => {
    expect([
      parseSidebarLayout(undefined),
      parseSidebarLayout(null),
      parseSidebarLayout('open'),
      parseSidebarLayout({}),
      parseSidebarLayout({ open: 'true' }),
      parseSidebarLayout({ open: true, width: '240' }),
      parseSidebarLayout({ open: true, width: Number.NaN }),
      parseSidebarLayout({ open: true, width: Number.POSITIVE_INFINITY }),
    ]).toEqual([undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined]);
  });
});
