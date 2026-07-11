import { describe, expect, it, vi } from 'vitest';
import { replaceEditor, type EditorSwitchActions } from '../../src/commands/editorSwitch';

function actions(overrides: Partial<EditorSwitchActions> = {}): EditorSwitchActions {
  return {
    closeCurrent: vi.fn().mockResolvedValue(true),
    openReplacement: vi.fn().mockResolvedValue(undefined),
    restoreCurrent: vi.fn().mockResolvedValue(undefined),
    reportOpenFailure: vi.fn(),
    ...overrides,
  };
}

describe('replaceEditor', () => {
  it('does not open the replacement editor when closing is cancelled', async () => {
    const subject = actions({ closeCurrent: vi.fn().mockResolvedValue(false) });

    expect(await replaceEditor(subject)).toBe(false);
    expect(subject.openReplacement).not.toHaveBeenCalled();
    expect(subject.restoreCurrent).not.toHaveBeenCalled();
  });

  it('opens the replacement editor only after the current editor closes', async () => {
    const order: string[] = [];
    const subject = actions({
      closeCurrent: vi.fn(() => {
        order.push('close');
        return Promise.resolve(true);
      }),
      openReplacement: vi.fn(() => {
        order.push('open');
        return Promise.resolve();
      }),
    });

    expect(await replaceEditor(subject)).toBe(true);
    expect(order).toEqual(['close', 'open']);
    expect(subject.restoreCurrent).not.toHaveBeenCalled();
  });

  it('restores the current editor and reports when opening fails', async () => {
    const openError = new Error('open failed');
    const subject = actions({ openReplacement: vi.fn().mockRejectedValue(openError) });

    expect(await replaceEditor(subject)).toBe(false);
    expect(subject.restoreCurrent).toHaveBeenCalledOnce();
    expect(subject.reportOpenFailure).toHaveBeenCalledWith(openError, undefined);
  });

  it('reports a restoration failure together with the opening failure', async () => {
    const openError = new Error('open failed');
    const restoreError = new Error('restore failed');
    const subject = actions({
      openReplacement: vi.fn().mockRejectedValue(openError),
      restoreCurrent: vi.fn().mockRejectedValue(restoreError),
    });

    expect(await replaceEditor(subject)).toBe(false);
    expect(subject.reportOpenFailure).toHaveBeenCalledWith(openError, restoreError);
  });
});
