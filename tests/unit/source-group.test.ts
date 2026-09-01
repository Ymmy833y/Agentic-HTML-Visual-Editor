import { describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import { resolveSourceGroup } from '../../src/commands/sourceGroup';

// resolveSourceGroup imports `vscode` only as a type, so a minimal fake is enough to drive it.
// Column identity is all that matters here, so the other TabGroup members are left out.

function group(viewColumn: number): vscode.TabGroup {
  return { viewColumn } as unknown as vscode.TabGroup;
}

describe('resolveSourceGroup', () => {
  it('follows the invoking column even when the active group points elsewhere', () => {
    // The measured bug itself: pressing the button in an auxiliary window (column 2) still leaves
    // activeTabGroup pointing at the main window (column 1).
    const main = group(1);
    const auxiliary = group(2);

    expect(resolveSourceGroup([main, auxiliary], main, 2)).toBe(auxiliary);
  });

  it('returns the active group when the invoking column is unknown', () => {
    // Entry points that cannot report a column, such as the command palette.
    const main = group(1);
    const auxiliary = group(2);

    expect(resolveSourceGroup([main, auxiliary], main, undefined)).toBe(main);
  });

  it('falls back to the active group when the invoking column no longer exists', () => {
    const main = group(1);

    expect(resolveSourceGroup([main], main, 3)).toBe(main);
  });

  it('returns the active group itself when it is the one invoked', () => {
    const main = group(1);
    const auxiliary = group(2);

    expect(resolveSourceGroup([main, auxiliary], auxiliary, 2)).toBe(auxiliary);
  });
});
