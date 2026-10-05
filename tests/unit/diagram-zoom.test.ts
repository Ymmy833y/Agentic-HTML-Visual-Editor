import { describe, expect, it } from 'vitest';

import { readNextZoomLevel } from '../../webview/ui/diagram-zoom';

describe('the next zoom level', () => {
  it('steps up from 100% to 125%', () => {
    expect(readNextZoomLevel(1, 'zoomIn')).toBe(1.25);
  });

  it('stays at 400% when zooming in at the top', () => {
    expect(readNextZoomLevel(4, 'zoomIn')).toBe(4);
  });

  it('stays at 50% when zooming out at the bottom', () => {
    expect(readNextZoomLevel(0.5, 'zoomOut')).toBe(0.5);
  });

  it('steps down from 200% to 150%', () => {
    expect(readNextZoomLevel(2, 'zoomOut')).toBe(1.5);
  });

  it('goes back to 100% on reset', () => {
    expect(readNextZoomLevel(3, 'reset')).toBe(1);
  });
});
