import { describe, expect, it } from 'vitest';
import { computeInitPayload } from '../../src/editor/backup';

const PEN = '<p>This is a pen.</p>';
const PEN_APPLE = ['<p>This is a pen.</p>', '<p>This is a apple.</p>'].join('\n');
const BANANA_PEN = ['<p>This is a banana.</p>', '<p>This is a pen.</p>'].join('\n');

describe('computeInitPayload', () => {
  it('mounts the document text when no backup exists', () => {
    expect(computeInitPayload(PEN, undefined)).toEqual({ html: PEN });
  });

  it('restores unsaved changes when the document is unchanged', () => {
    const payload = computeInitPayload(PEN, { baseHtml: PEN, html: PEN_APPLE });
    expect(payload.html).toBe(PEN);
    expect(payload.restored).toBe(PEN_APPLE);
  });

  it('restores unsaved changes merged with a document changed in the meantime (reported scenario)', () => {
    const payload = computeInitPayload(BANANA_PEN, { baseHtml: PEN, html: PEN_APPLE });
    expect(payload.html).toBe(BANANA_PEN);
    expect(payload.restored).toBe(
      [
        '<p>This is a banana.</p>',
        '<p>This is a pen.</p>',
        '<p>This is a apple.</p>',
      ].join('\n'),
    );
  });

  it('consumes a backup whose content was saved (backup equals the document)', () => {
    const payload = computeInitPayload(PEN_APPLE, { baseHtml: PEN, html: PEN_APPLE });
    expect(payload.restored).toBeUndefined();
  });

  it('consumes a backup whose changes the document already contains', () => {
    const docWithAll = [
      '<p>This is a banana.</p>',
      '<p>This is a pen.</p>',
      '<p>This is a apple.</p>',
    ].join('\n');
    const payload = computeInitPayload(docWithAll, { baseHtml: PEN, html: PEN_APPLE });
    expect(payload.restored).toBeUndefined();
  });

  it('consumes a backup that never diverged from its base', () => {
    const payload = computeInitPayload(BANANA_PEN, { baseHtml: PEN, html: PEN });
    expect(payload.restored).toBeUndefined();
  });
});
