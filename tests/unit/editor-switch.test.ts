import { describe, expect, it, vi } from 'vitest';
import { replaceEditor, type EditorSwitchActions } from '../../src/commands/editorSwitch';

function actions(overrides: Partial<EditorSwitchActions> = {}): EditorSwitchActions {
  return {
    openReplacement: vi.fn().mockResolvedValue(undefined),
    closeCurrent: vi.fn().mockResolvedValue(true),
    undoReplacement: vi.fn().mockResolvedValue(undefined),
    reportOpenFailure: vi.fn(),
    ...overrides,
  };
}

describe('replaceEditor', () => {
  it('opens the replacement editor before closing the current one', () => {
    // In the opposite order, closing the last tab of the group takes the group (the auxiliary
    // window) down with it, leaving nowhere to open into.
    const order: string[] = [];
    const subject = actions({
      openReplacement: vi.fn(() => {
        order.push('open');
        return Promise.resolve();
      }),
      closeCurrent: vi.fn(() => {
        order.push('close');
        return Promise.resolve(true);
      }),
    });

    return replaceEditor(subject).then((result) => {
      expect(result).toBe(true);
      expect(order).toEqual(['open', 'close']);
      expect(subject.undoReplacement).not.toHaveBeenCalled();
    });
  });

  it('does not close the current editor when the replacement cannot be opened', async () => {
    const openError = new Error('open failed');
    const subject = actions({ openReplacement: vi.fn().mockRejectedValue(openError) });

    expect(await replaceEditor(subject)).toBe(false);
    expect(subject.closeCurrent).not.toHaveBeenCalled();
    // Nothing has been closed yet, so there is nothing to undo.
    expect(subject.undoReplacement).not.toHaveBeenCalled();
    expect(subject.reportOpenFailure).toHaveBeenCalledWith(openError);
  });

  it('undoes the replacement when closing is cancelled', async () => {
    const subject = actions({ closeCurrent: vi.fn().mockResolvedValue(false) });

    expect(await replaceEditor(subject)).toBe(false);
    expect(subject.undoReplacement).toHaveBeenCalledOnce();
    expect(subject.reportOpenFailure).not.toHaveBeenCalled();
  });
});
