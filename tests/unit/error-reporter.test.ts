// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { createLocalizer } from '../../common/index';
import { ErrorReporter } from '../../src/diagnostics/error-reporter';
import type { DiagnosticLog, NotificationPresenter } from '../../src/diagnostics/error-reporter';

// Use values that differ from their keys to verify that notifications are resolved from the message catalog.
const CATALOG = {
  'documentUnreadable.message': 'Could not read the file.',
  'errorReport.showDetails': 'Show Details',
};

const SHOW_DETAILS = CATALOG['errorReport.showDetails'];

/** Calls received by the diagnostic log output. */
interface LogCalls {
  readonly lines: string[];
  readonly shownTimes: () => number;
}

/** Calls received by the notification output. */
interface PresenterCalls {
  readonly messages: string[];
  readonly actions: string[][];
  /** The severities of the presenters called, in the same order as the messages. */
  readonly severities: ('error' | 'information')[];
}

/**
 * Creates a diagnostic log output that only records calls.
 *
 * @param failing Whether appending a line throws.
 * @param failingShow Whether bringing the log to the front throws.
 */
function createLog(failing = false, failingShow = false): DiagnosticLog & LogCalls {
  const lines: string[] = [];
  let shown = 0;

  return {
    lines,
    shownTimes: () => shown,
    appendLine(value: string): void {
      lines.push(value);
      if (failing) {
        throw new Error('Failed to write to the diagnostic log');
      }
    },
    show(): void {
      shown += 1;
      if (failingShow) {
        throw new Error('Could not open the diagnostic log');
      }
    },
  };
}

/**
 * Creates a notification output with a predetermined user action.
 *
 * @param chosen The action selected by the user, or `undefined` if no action is selected.
 * @param failing Whether waiting for the action fails.
 */
function createPresenter(
  chosen?: string,
  failing = false,
): NotificationPresenter & PresenterCalls {
  const messages: string[] = [];
  const actions: string[][] = [];
  const severities: ('error' | 'information')[] = [];
  const show = (severity: 'error' | 'information', message: string, items: string[]): PromiseLike<string | undefined> => {
    severities.push(severity);
    messages.push(message);
    actions.push(items);
    return failing ? Promise.reject(new Error('Failed to show the notification')) : Promise.resolve(chosen);
  };

  return {
    messages,
    actions,
    severities,
    showMessage: (message: string, ...items: string[]) => show('error', message, items),
    showInformation: (message: string, ...items: string[]) => show('information', message, items),
  };
}

/**
 * Creates an error reporter with replaceable outputs.
 *
 * @param log The diagnostic log output.
 * @param presenter The notification output.
 */
function createReporter(
  log: DiagnosticLog,
  presenter: NotificationPresenter,
  inspectionEnabled = true,
): ErrorReporter {
  return new ErrorReporter(log, presenter, createLocalizer(CATALOG), inspectionEnabled);
}

describe('error reporting', () => {
  it('adds one diagnostic log line when an internal error is reported', () => {
    const reporter = createReporter(createLog(), createPresenter());

    reporter.reportInternalError('A stale registration remained');

    expect(reporter.readInspection().logLines).toEqual(['A stale registration remained']);
  });

  it('does not add a notification when an internal error is reported', () => {
    const reporter = createReporter(createLog(), createPresenter());

    reporter.reportInternalError('A stale registration remained');

    expect(reporter.readInspection().notifications).toEqual([]);
  });

  it('writes an internal error only to the supplied diagnostic log output', () => {
    const log = createLog();
    const presenter = createPresenter();
    const reporter = createReporter(log, presenter);

    reporter.reportInternalError('A stale registration remained');

    expect([log.lines, presenter.messages]).toEqual([['A stale registration remained'], []]);
  });

  it('resolves a user-facing error notification from the message catalog', async () => {
    const presenter = createPresenter();
    const reporter = createReporter(createLog(), presenter);

    await reporter.reportUserError('documentUnreadable.message');

    expect(presenter.messages).toEqual([CATALOG['documentUnreadable.message']]);
  });

  it('adds one notification and diagnostic log line for a user-facing error with a cause', async () => {
    const reporter = createReporter(createLog(), createPresenter());

    await reporter.reportUserError('documentUnreadable.message', 'Failed to read the document');

    expect(reporter.readInspection()).toEqual({
      notifications: [CATALOG['documentUnreadable.message']],
      logLines: ['Failed to read the document'],
    });
  });

  it('includes an action to open the diagnostic log in a notification with a cause', async () => {
    const presenter = createPresenter();
    const reporter = createReporter(createLog(), presenter);

    await reporter.reportUserError('documentUnreadable.message', 'Failed to read the document');

    expect(presenter.actions).toEqual([[SHOW_DETAILS]]);
  });

  it('does not add a diagnostic log line for a user-facing error without a cause', async () => {
    const reporter = createReporter(createLog(), createPresenter());

    await reporter.reportUserError('documentUnreadable.message');

    expect(reporter.readInspection().logLines).toEqual([]);
  });

  it('does not include an action in a notification without a cause', async () => {
    const presenter = createPresenter();
    const reporter = createReporter(createLog(), presenter);

    await reporter.reportUserError('documentUnreadable.message');

    expect(presenter.actions).toEqual([[]]);
  });

  it('does not bring the diagnostic log to the front merely by reporting an error', async () => {
    const log = createLog();
    const reporter = createReporter(log, createPresenter());

    reporter.reportInternalError('A stale registration remained');
    await reporter.reportUserError('documentUnreadable.message', 'Failed to read the document');

    expect(log.shownTimes()).toBe(0);
  });

  it('brings the diagnostic log to the front when the user selects the notification action', async () => {
    const log = createLog();
    const reporter = createReporter(log, createPresenter(SHOW_DETAILS));

    await reporter.reportUserError('documentUnreadable.message', 'Failed to read the document');

    expect(log.shownTimes()).toBe(1);
  });

  it('does not throw from the reporting call when the diagnostic log output throws', () => {
    const reporter = createReporter(createLog(true), createPresenter());

    expect(() => reporter.reportInternalError('A stale registration remained')).not.toThrow();
  });

  it('does not reject the reporting call when waiting for the notification fails', async () => {
    const reporter = createReporter(createLog(), createPresenter(undefined, true));

    await expect(
      reporter.reportUserError('documentUnreadable.message', 'Failed to read the document'),
    ).resolves.toBeUndefined();
  });

  it('does not reject the reporting call when bringing the diagnostic log to the front throws', async () => {
    const reporter = createReporter(createLog(false, true), createPresenter(SHOW_DETAILS));

    await expect(
      reporter.reportUserError('documentUnreadable.message', 'Failed to read the document'),
    ).resolves.toBeUndefined();
  });

  it('clears both notifications and diagnostic log lines from the inspection', async () => {
    const reporter = createReporter(createLog(), createPresenter());
    reporter.reportInternalError('A stale registration remained');
    await reporter.reportUserError('documentUnreadable.message', 'Failed to read the document');

    reporter.clearInspection();

    expect(reporter.readInspection()).toEqual({ notifications: [], logLines: [] });
  });

  it('does not mutate an inspection when reporting continues after it is read', () => {
    const reporter = createReporter(createLog(), createPresenter());
    reporter.reportInternalError('entry 1');

    const inspection = reporter.readInspection();
    reporter.reportInternalError('entry 2');

    expect(inspection.logLines).toEqual(['entry 1']);
  });

  it('retains the latest 100 diagnostic log lines and discards the oldest after reporting 101', () => {
    const reporter = createReporter(createLog(), createPresenter());

    for (let index = 1; index <= 101; index += 1) {
      reporter.reportInternalError(`entry ${index}`);
    }

    const { logLines } = reporter.readInspection();
    expect([logLines.length, logLines[0], logLines[99]]).toEqual([100, 'entry 2', 'entry 101']);
  });

  it('retains the latest 100 notifications and discards the oldest after reporting 101', async () => {
    const reporter = createReporter(createLog(), createPresenter());

    // Use a different key for the first report so the discarded entry is distinguishable.
    await reporter.reportUserError('errorReport.showDetails');
    for (let index = 1; index <= 100; index += 1) {
      await reporter.reportUserError('documentUnreadable.message');
    }

    const { notifications } = reporter.readInspection();
    expect([notifications.length, notifications[0]]).toEqual([100, CATALOG['documentUnreadable.message']]);
  });

  it('still shows a notification but does not add it to the inspection when constructed as disabled', async () => {
    const presenter = createPresenter();
    const reporter = createReporter(createLog(), presenter, false);

    await reporter.reportUserError('documentUnreadable.message');

    expect(presenter.messages).toEqual([CATALOG['documentUnreadable.message']]);
    expect(reporter.readInspection().notifications).toEqual([]);
  });

  it('still writes to the diagnostic log but does not add the line to the inspection when constructed as disabled', () => {
    const log = createLog();
    const reporter = createReporter(log, createPresenter(), false);

    reporter.reportInternalError('A stale registration remained');

    expect(log.lines).toEqual(['A stale registration remained']);
    expect(reporter.readInspection().logLines).toEqual([]);
  });
});

describe('notifications with actions', () => {
  // Action display labels differ from their keys, which confirms that keys, not display labels, are returned.
  const ACTION_CATALOG = {
    'protection.preserved.message': 'Content preserved.',
    'recovery.recover': 'Recover',
    'recovery.saveAs': 'Save As...',
  };

  it('returns notification actions as message keys and does not turn a notification failure into a protection wait or backup verification failure', async () => {
    const chosen = new ErrorReporter(
      createLog(),
      createPresenter(ACTION_CATALOG['recovery.recover']),
      createLocalizer(ACTION_CATALOG),
      true,
    );
    const failing = new ErrorReporter(
      createLog(),
      createPresenter(undefined, true),
      createLocalizer(ACTION_CATALOG),
      true,
    );

    await expect(chosen.reportUserAction('protection.preserved.message', ['recovery.saveAs', 'recovery.recover']))
      .resolves.toBe('recovery.recover');
    await expect(failing.reportUserAction('protection.preserved.message', ['recovery.recover'], 'cause'))
      .resolves.toBeUndefined();
  });

  it('shows success notices through a presenter separate from errors and failure notices through the error presenter', async () => {
    const presenter = createPresenter(ACTION_CATALOG['recovery.recover']);
    const reporter = new ErrorReporter(createLog(), presenter, createLocalizer(ACTION_CATALOG), true);

    await expect(reporter.reportUserInformation('protection.preserved.message', ['recovery.recover']))
      .resolves.toBe('recovery.recover');
    await reporter.reportUserAction('protection.preserved.message', []);

    expect(presenter.severities).toEqual(['information', 'error']);
    expect(reporter.readInspection().notifications).toEqual([
      ACTION_CATALOG['protection.preserved.message'],
      ACTION_CATALOG['protection.preserved.message'],
    ]);
  });
});
