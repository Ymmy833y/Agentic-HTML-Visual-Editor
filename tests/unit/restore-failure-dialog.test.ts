import { describe, expect, it } from 'vitest';

import { createLocalizer } from '../../common/index';
import type { Localizer, RestoreAction } from '../../common/index';
import { buildRestoreFailureOverlay } from '../../webview/ui/restore-failure-dialog';

const HEADING = 'Could not restore';
const BACKUP_UNREADABLE = 'Cannot read the backup';
const DISPLAY_FAILED = 'Cannot display';

// These tests check which message was chosen and how many actions there are, so short values suffice for the
// messages themselves.
const localizer: Localizer = createLocalizer({
  'restoreFailure.heading': HEADING,
  'restoreFailure.backupUnreadable': BACKUP_UNREADABLE,
  'restoreFailure.displayFailed': DISPLAY_FAILED,
  'restore.retry': 'Retry',
  'restore.discard': 'Discard',
});

const ignoreSelection = (): void => undefined;

describe('the content of the restore failure overlay', () => {
  it('varies the description by cause', () => {
    expect([
      buildRestoreFailureOverlay(localizer, 'backupUnreadable', ignoreSelection).descriptions,
      buildRestoreFailureOverlay(localizer, 'displayFailed', ignoreSelection).descriptions,
    ]).toEqual([[BACKUP_UNREADABLE], [DISPLAY_FAILED]]);
  });

  it('lays out retry and discard in that order', () => {
    const content = buildRestoreFailureOverlay(localizer, 'backupUnreadable', ignoreSelection);

    expect(content.actions.map((action) => action.label)).toEqual(['Retry', 'Discard']);
  });

  it('hands the chosen action to the receiver exactly once on a press', () => {
    const selected: RestoreAction[] = [];
    const content = buildRestoreFailureOverlay(localizer, 'backupUnreadable', (action) => selected.push(action));

    for (const action of content.actions) {
      action.run();
    }

    expect(selected).toEqual(['retry', 'discard']);
  });
});
