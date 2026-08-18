import { describe, expect, it, vi } from 'vitest';
import { createTestApi, type WysiwygTestTarget } from '../../src/testing/test-api';

// `createTestApi` uses `vscode` for types only, so it can be driven with a fake
// provider. The uri is merely passed through, so any identifiable value will do.

type Uri = Parameters<WysiwygTestTarget['fireTestEdit']>[0];

const URI = { marker: 'uri' } as unknown as Uri;

// Keep the mocks as individual consts: referencing them as methods, like
// `target.fireTestEdit`, trips typescript-eslint's unbound-method rule.
function fakeTarget() {
  const fireTestEdit = vi.fn(() => true);
  const setTestViewHtml = vi.fn(() => true);
  const getTestViewHtml = vi.fn(() => Promise.resolve('<p>view</p>'));
  const requestTestViewSave = vi.fn(() => false);
  const openTestRelativeFile = vi.fn(() => Promise.resolve(true));
  const openTestRelativeFileViaWebview = vi.fn(() => false);
  const target: WysiwygTestTarget = {
    fireTestEdit,
    setTestViewHtml,
    getTestViewHtml,
    requestTestViewSave,
    openTestRelativeFile,
    openTestRelativeFileViaWebview,
  };
  return {
    target,
    fireTestEdit,
    setTestViewHtml,
    getTestViewHtml,
    requestTestViewSave,
    openTestRelativeFile,
    openTestRelativeFileViaWebview,
  };
}

describe('createTestApi', () => {
  it('forwards each hook and its arguments to the matching target method', () => {
    const fake = fakeTarget();
    const api = createTestApi(fake.target);

    api.fireWysiwygEdit(URI);
    api.setWysiwygTestHtml(URI, '<p>next</p>');
    void api.getWysiwygTestHtml(URI);
    api.requestWysiwygTestSave(URI);
    void api.openWysiwygTestRelativeFile(URI, './a.html');
    api.openWysiwygTestRelativeFileViaWebview(URI, './b.html');

    expect(fake.fireTestEdit).toHaveBeenCalledWith(URI);
    expect(fake.setTestViewHtml).toHaveBeenCalledWith(URI, '<p>next</p>');
    expect(fake.getTestViewHtml).toHaveBeenCalledWith(URI);
    expect(fake.requestTestViewSave).toHaveBeenCalledWith(URI);
    expect(fake.openTestRelativeFile).toHaveBeenCalledWith(URI, './a.html');
    expect(fake.openTestRelativeFileViaWebview).toHaveBeenCalledWith(URI, './b.html');
  });

  it('returns each target method result unchanged', async () => {
    const api = createTestApi(fakeTarget().target);

    expect(api.fireWysiwygEdit(URI)).toBe(true);
    expect(api.setWysiwygTestHtml(URI, '<p>next</p>')).toBe(true);
    expect(api.requestWysiwygTestSave(URI)).toBe(false);
    expect(api.openWysiwygTestRelativeFileViaWebview(URI, './b.html')).toBe(false);
    await expect(api.getWysiwygTestHtml(URI)).resolves.toBe('<p>view</p>');
    await expect(api.openWysiwygTestRelativeFile(URI, './a.html')).resolves.toBe(true);
  });

  // The integration tests depend on the shape of activate's return value. If even one
  // hook is missing, the tests that use it only find out at run time.
  it('provides all six AhveTestApi hooks', () => {
    const api = createTestApi(fakeTarget().target);

    expect(Object.keys(api).sort()).toEqual([
      'fireWysiwygEdit',
      'getWysiwygTestHtml',
      'openWysiwygTestRelativeFile',
      'openWysiwygTestRelativeFileViaWebview',
      'requestWysiwygTestSave',
      'setWysiwygTestHtml',
    ]);
  });
});
