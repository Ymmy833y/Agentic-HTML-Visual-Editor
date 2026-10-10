// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { decideRestoreMount } from '../../common/index';
import type { RestoreProgress } from '../../common/index';

const SOURCE_TEXT = '<!DOCTYPE html>\n<html>\n<body>\n<p>a</p>\n</body>\n</html>\n';
const RESTORED_TEXT = '<!DOCTYPE html>\n<html>\n<body>\n<p>ab</p>\n</body>\n</html>\n';
const RETAINED_COPY = '<!DOCTYPE html>\n<html>\n<body>\n<p>abc</p>\n</body>\n</html>\n';

/**
 * Decides with the view ready input.
 *
 * @param retainedCopy The retained copy, or `undefined` if missing.
 * @param progress The restore progress.
 */
function decideOnViewReady(retainedCopy: string | undefined, progress: RestoreProgress): ReturnType<typeof decideRestoreMount> {
  return decideRestoreMount({ kind: 'viewReady', retainedCopy, progress });
}

describe('difference decision after the merge', () => {
  it('returns a decision to mount the restored full text when it differs from the current source', () => {
    const decision = decideRestoreMount({
      kind: 'merged',
      sourceText: SOURCE_TEXT,
      restoredText: RESTORED_TEXT,
    });

    expect(decision).toEqual({ kind: 'mountRestored', text: RESTORED_TEXT });
  });

  it('returns a decision to mount the current source when the restored full text matches it', () => {
    const decision = decideRestoreMount({
      kind: 'merged',
      sourceText: SOURCE_TEXT,
      restoredText: SOURCE_TEXT,
    });

    expect(decision).toEqual({ kind: 'mountSource', text: SOURCE_TEXT });
  });

  it('treats a restored full text that differs from the current source only in line endings as matching', () => {
    const decision = decideRestoreMount({
      kind: 'merged',
      sourceText: SOURCE_TEXT,
      restoredText: SOURCE_TEXT.replace(/\n/g, '\r\n'),
    });

    expect(decision).toEqual({ kind: 'mountSource', text: SOURCE_TEXT });
  });
});

describe('decision on view ready', () => {
  it('returns redisplay whenever there is a retained copy, regardless of the restore progress', () => {
    const decisions = (['notStarted', 'prepared', 'restored', 'normal', 'failed'] satisfies RestoreProgress[])
      .map((progress) => decideOnViewReady(RETAINED_COPY, progress));

    expect(decisions).toEqual(decisions.map(() => ({ kind: 'redisplay', text: RETAINED_COPY })));
  });

  it('returns redisplay for an empty retained copy, distinguishing it from a missing one', () => {
    const decision = decideOnViewReady('', 'notStarted');

    expect(decision).toEqual({ kind: 'redisplay', text: '' });
  });

  it('returns start restore when there is no retained copy and the restore has not started', () => {
    expect(decideOnViewReady(undefined, 'notStarted')).toEqual({ kind: 'startRestore' });
  });

  it('returns await settlement when there is no retained copy and the restore is prepared', () => {
    expect(decideOnViewReady(undefined, 'prepared')).toEqual({ kind: 'awaitSettlement' });
  });

  it('returns show failure when there is no retained copy and the restore failed', () => {
    expect(decideOnViewReady(undefined, 'failed')).toEqual({ kind: 'showFailure' });
  });

  it('returns normal initialization when there is no retained copy and the restore is restored or started normally', () => {
    const decisions = [decideOnViewReady(undefined, 'restored'), decideOnViewReady(undefined, 'normal')];

    expect(decisions).toEqual([{ kind: 'initializeNormally' }, { kind: 'initializeNormally' }]);
  });
});
