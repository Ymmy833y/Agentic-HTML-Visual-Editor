import type { Localizer, MessageKey, MessageParams } from '../../common/index';

/**
 * The diagnostic log output.
 *
 * A VS Code output channel directly implements this interface. This module does not call the VS
 * Code API directly so tests can pass an output that throws and verify that output failures do not
 * stop the primary operation.
 */
export interface DiagnosticLog {
  /** Appends one line to the diagnostic log. */
  appendLine(value: string): void;
  /** Brings the diagnostic log to the front. Called only in response to a user action. */
  show(): void;
}

/** The notification output. */
export interface NotificationPresenter {
  /**
   * Shows a notification and waits for the user to select an action.
   *
   * @param message The message to display.
   * @param actions The action labels to include. May be empty.
   * @returns The selected action label, or `undefined` if no action was selected.
   */
  showMessage(message: string, ...actions: string[]): PromiseLike<string | undefined>;

  /**
   * Shows a success or completion notice at a severity distinct from errors and waits for an action to be selected.
   *
   * @param message The body to show.
   * @param actions The display labels of the actions to offer. May be empty.
   * @returns The display label of the selected action, or `undefined` if none was selected.
   */
  showInformation(message: string, ...actions: string[]): PromiseLike<string | undefined>;
}

/** Notification severity. Showing a success notice as an error would make the user mistake it for a failure. */
type NotificationSeverity = 'error' | 'information';

/**
 * A narrow sink that accepts only internal errors.
 *
 * Code that does not use VS Code receives this interface. Implementations must not throw because a
 * secondary reporting failure would stop the primary operation merely for trying to record a failure.
 */
export interface InternalErrorSink {
  /**
   * Records a fact that the user cannot act on in the diagnostic log.
   *
   * @param detail One line intended for maintainers.
   */
  reportInternalError(detail: string): void;
}

/** A value inspection of the reported output that excludes the outputs themselves. */
export interface DiagnosticInspection {
  /** The notification messages in the order they were sent. */
  readonly notifications: readonly string[];
  /** The diagnostic log lines in output order. */
  readonly logLines: readonly string[];
}

// The maximum number of entries retained for inspection. Tests need only the latest few entries;
// retaining entries throughout a long-running session would consume memory indefinitely.
const INSPECTION_CAPACITY = 100;

/**
 * Sends reported events to the notification and diagnostic log outputs.
 *
 * One pair of outputs is created during activation and passed in. If each component created its own
 * outputs, multiple output channels would split the diagnostic log across locations visible to the user.
 */
export class ErrorReporter implements InternalErrorSink {
  private readonly notifications: string[] = [];

  private readonly logLines: string[] = [];

  /**
   * Receives the outputs and localizer.
   *
   * @param log The diagnostic log output.
   * @param presenter The notification output.
   * @param localizer The localizer used to resolve notification messages.
   * @param inspectionEnabled Whether the inspection record is kept.
   */
  constructor(
    private readonly log: DiagnosticLog,
    private readonly presenter: NotificationPresenter,
    private readonly localizer: Localizer,
    private readonly inspectionEnabled: boolean,
  ) {}

  /**
   * Records a fact that the user cannot act on only in the diagnostic log.
   *
   * It does not show a notification because notifications interrupt the user's work. Showing
   * non-actionable notifications eventually teaches users to ignore the notifications themselves.
   *
   * @param detail One line intended for maintainers. It does not use the message catalog because only
   * maintainers read it.
   */
  reportInternalError(detail: string): void {
    this.appendLogLine(detail);
  }

  /**
   * Notifies the user of an actionable failure and records its cause when available.
   *
   * The notification states only what happened and the state of the edits; the diagnostic log holds
   * the cause. The action to open the log is included only when a cause exists so the user never sees
   * an action that opens an empty log.
   *
   * @param key The message key for the notification.
   * @param cause One line describing the cause for the diagnostic log. Omitting it shows only the notification.
   * @returns A promise that resolves when the notification closes. It never rejects on failure.
   */
  async reportUserError(key: MessageKey, cause?: string): Promise<void> {
    if (cause !== undefined) {
      this.appendLogLine(cause);
    }

    const message = this.localizer.getMessage(key);
    // Add the message to the inspection before calling the output. Tests must be able to observe that
    // reporting was attempted even if the output throws.
    if (this.inspectionEnabled) {
      pushWithinCapacity(this.notifications, message);
    }

    if (cause === undefined) {
      await this.present(message);
      return;
    }

    const showDetails = this.localizer.getMessage('errorReport.showDetails');
    if ((await this.present(message, showDetails)) !== showDetails) {
      return;
    }

    try {
      // This is the only place that brings the log to the front. Doing so merely because an event was
      // reported would take over the UI to show information the user cannot act on.
      this.log.show();
    } catch {
      // Reporting that the diagnostic log could not be opened would give the user no additional action.
    }
  }

  /**
   * Tells the user a result and offers the actions they can take next.
   *
   * The selected action is returned as a message key, not a display label. Branching on the display language would
   * break the action whenever a translation changed.
   * Callers do not include this Promise in waits for backup verification, failure responses, or save completion,
   * because it does not resolve until the user dismisses the notification.
   *
   * @param key The message key of the notification body.
   * @param actions The message keys of the actions. May be empty.
   * @param cause The cause to record in the diagnostic log.
   * @param params Values for the placeholders in the body.
   * @returns The message key of the selected action, or `undefined` if none was selected or the notification failed.
   */
  async reportUserAction<TAction extends MessageKey>(
    key: MessageKey,
    actions: readonly TAction[],
    cause?: string,
    params?: MessageParams,
  ): Promise<TAction | undefined> {
    if (cause !== undefined) {
      this.appendLogLine(cause);
    }
    return this.presentActions('error', key, actions, params);
  }

  /**
   * Tells the user of a success or completion and offers the actions they can take next.
   *
   * Using the same presenter as error notifications would show a successful save or recovery as a failure. There is
   * no cause, so nothing is recorded in the diagnostic log.
   *
   * @param key The message key of the notification body.
   * @param actions The message keys of the actions. May be empty.
   * @param params Values for the placeholders in the body.
   * @returns The message key of the selected action, or `undefined` if none was selected or the notification failed.
   */
  async reportUserInformation<TAction extends MessageKey>(
    key: MessageKey,
    actions: readonly TAction[],
    params?: MessageParams,
  ): Promise<TAction | undefined> {
    return this.presentActions('information', key, actions, params);
  }

  /**
   * Returns a value inspection of the reported output.
   *
   * Neither notifications nor output channels expose their results, so tests can inspect them only
   * through this entry point.
   *
   * @returns The notification messages and diagnostic log lines. Later reports do not mutate them.
   */
  readInspection(): DiagnosticInspection {
    return { notifications: [...this.notifications], logLines: [...this.logLines] };
  }

  /**
   * Clears the inspection.
   *
   * The inspection accumulates throughout the extension's lifetime. Without this method, a test would
   * count reports from earlier tests. It does not touch the outputs, so the output channel contents and
   * displayed notifications remain unchanged.
   */
  clearInspection(): void {
    this.notifications.length = 0;
    this.logLines.length = 0;
  }

  /**
   * Calls the notification output and suppresses failures.
   *
   * @param message The message to display.
   * @param actions The action labels to include.
   * @returns The selected action label, or `undefined` if none was selected or the output failed.
   */
  private async present(message: string, ...actions: string[]): Promise<string | undefined> {
    return this.presentWithSeverity('error', message, actions);
  }

  /**
   * Notifies at the given severity and returns the selected action as a message key.
   *
   * @param severity The notification severity.
   * @param key The message key of the notification body.
   * @param actions The message keys of the actions.
   * @param params Values for the placeholders in the body.
   */
  private async presentActions<TAction extends MessageKey>(
    severity: NotificationSeverity,
    key: MessageKey,
    actions: readonly TAction[],
    params: MessageParams | undefined,
  ): Promise<TAction | undefined> {
    const message = this.localizer.getMessage(key, params);
    if (this.inspectionEnabled) {
      pushWithinCapacity(this.notifications, message);
    }

    const labels = actions.map((action) => this.localizer.getMessage(action));
    const selected = await this.presentWithSeverity(severity, message, labels);
    const index = selected === undefined ? -1 : labels.indexOf(selected);
    return index < 0 ? undefined : actions[index];
  }

  /**
   * Calls the presenter for the severity and suppresses failures.
   *
   * @param severity The notification severity.
   * @param message The body to show.
   * @param actions The display labels of the actions.
   */
  private async presentWithSeverity(
    severity: NotificationSeverity,
    message: string,
    actions: readonly string[],
  ): Promise<string | undefined> {
    try {
      return severity === 'information'
        ? await this.presenter.showInformation(message, ...actions)
        : await this.presenter.showMessage(message, ...actions);
    } catch {
      return undefined;
    }
  }

  /**
   * Writes one line to the diagnostic log and adds the same line to the inspection.
   *
   * @param line The line to write to the diagnostic log.
   */
  private appendLogLine(line: string): void {
    if (this.inspectionEnabled) {
      pushWithinCapacity(this.logLines, line);
    }

    try {
      this.log.appendLine(line);
    } catch {
      // Do not expose output failures to the caller. Propagating an exception here would make reporting
      // create a secondary failure.
    }
  }
}

/**
 * Appends a value while discarding the oldest value when necessary to stay within the capacity.
 *
 * @param entries The array to append to.
 * @param entry The value to append.
 */
function pushWithinCapacity(entries: string[], entry: string): void {
  entries.push(entry);
  if (entries.length > INSPECTION_CAPACITY) {
    entries.shift();
  }
}
