import { describe, expect, it, vi } from 'vitest';
import { replaceEditor, type EditorSwitchActions } from '../../src/commands/editorSwitch';

function actions(overrides: Partial<EditorSwitchActions> = {}): EditorSwitchActions {
  return {
    closeSource: vi.fn().mockResolvedValue(true),
    openVisual: vi.fn().mockResolvedValue(undefined),
    restoreSource: vi.fn().mockResolvedValue(undefined),
    reportOpenFailure: vi.fn(),
    ...overrides,
  };
}

describe('replaceEditor', () => {
  it('does not open the visual editor when closing is cancelled', async () => {
    const subject = actions({ closeSource: vi.fn().mockResolvedValue(false) });

    expect(await replaceEditor(subject)).toBe(false);
    expect(subject.openVisual).not.toHaveBeenCalled();
    expect(subject.restoreSource).not.toHaveBeenCalled();
  });

  it('opens the visual editor only after the source editor closes', async () => {
    const order: string[] = [];
    const subject = actions({
      closeSource: vi.fn(() => {
        order.push('close');
        return Promise.resolve(true);
      }),
      openVisual: vi.fn(() => {
        order.push('open');
        return Promise.resolve();
      }),
    });

    expect(await replaceEditor(subject)).toBe(true);
    expect(order).toEqual(['close', 'open']);
    expect(subject.restoreSource).not.toHaveBeenCalled();
  });

  it('restores the source editor and reports when opening fails', async () => {
    const openError = new Error('open failed');
    const subject = actions({ openVisual: vi.fn().mockRejectedValue(openError) });

    expect(await replaceEditor(subject)).toBe(false);
    expect(subject.restoreSource).toHaveBeenCalledOnce();
    expect(subject.reportOpenFailure).toHaveBeenCalledWith(openError, undefined);
  });

  it('reports a restoration failure together with the opening failure', async () => {
    const openError = new Error('open failed');
    const restoreError = new Error('restore failed');
    const subject = actions({
      openVisual: vi.fn().mockRejectedValue(openError),
      restoreSource: vi.fn().mockRejectedValue(restoreError),
    });

    expect(await replaceEditor(subject)).toBe(false);
    expect(subject.reportOpenFailure).toHaveBeenCalledWith(openError, restoreError);
  });
});
