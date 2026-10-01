import { isRelativeFileHref } from '../../common/index';
import type { MessageKey } from '../../common/index';
import type { InternalErrorSink } from '../diagnostics/error-reporter';
import { isPathWithinScope, resolveTargetPath } from './link-path';

/**
 * Reasons a link was not opened.
 *
 * Each diagnostic log line carries this spelling as is, so the reasons are closed to these eight and no other value is
 * created.
 */
export const LINK_OPEN_FAILURE = {
  outsideContract: 'outsideContract',
  notRelative: 'notRelative',
  unresolvable: 'unresolvable',
  outsideScope: 'outsideScope',
  notFound: 'notFound',
  notFile: 'notFile',
  openFailed: 'openFailed',
  unexpectedError: 'unexpectedError',
} as const;

/** A reason a link was not opened. */
export type LinkOpenFailure = (typeof LINK_OPEN_FAILURE)[keyof typeof LINK_OPEN_FAILURE];

/** The result of an opening operation. A failure includes a one-sentence cause. */
export type LinkOpenAttempt =
  | { readonly opened: true }
  | { readonly opened: false; readonly cause: string };

/**
 * The existence and type of the target, checked before opening.
 *
 * Notifications do not distinguish a directory from an unknown entry, so both are folded into not a file, and the
 * entry type is kept in the cause of the diagnostic log line.
 */
export type LinkTargetCheck =
  | { readonly kind: 'file' }
  | { readonly kind: 'notFound' }
  // Exists but is not a file. An unknown entry is one that VS Code reports as neither a file nor a directory.
  | { readonly kind: 'notFile'; readonly entryType: 'directory' | 'unknown' }
  // The query failed for a reason other than not found. The target cannot be said to be missing, so this is kept
  // separate from not found.
  | { readonly kind: 'openFailed'; readonly cause: string };

/** Ports bound to the base document for the scope root depth, the link target check, and the opening operation. */
export interface RelativeLinkHost {
  /** The base document URI path, fixed when the ports are created and unaffected by request values. */
  readonly documentPath: string;

  /**
   * Returns the depth of the scope root.
   *
   * Resolves it for every request because the workspace configuration may change while it remains open.
   */
  resolveScopeDepth(): number;

  /**
   * Checks the existence and type of the target.
   *
   * A failed query is also returned as one of the four values, without throwing.
   *
   * @param targetPath The target path determined to be within scope.
   * @returns The existence and type of the target.
   */
  checkLinkTarget(targetPath: string): Promise<LinkTargetCheck>;

  /**
   * Opens a target path in a VS Code tab.
   *
   * @param targetPath The target path determined to be within scope.
   * @returns Whether it opened, or a failure with its cause.
   */
  openLinkTarget(targetPath: string): Promise<LinkOpenAttempt>;
}

/**
 * The link failure reporter that receives results where the link was not opened.
 *
 * The error reporter satisfies it as is. Both ports are called on the assumption that they do not throw.
 */
export interface LinkFailureReporter extends InternalErrorSink {
  /**
   * Notifies the user of an error and writes the cause to the diagnostic log.
   *
   * @param key The message key of the notification.
   * @param cause The one line written to the diagnostic log.
   * @returns A Promise that resolves when the notification closes.
   */
  reportUserError(key: MessageKey, cause: string): Promise<void>;
}

/**
 * The notification message key for each reason a link was not opened.
 *
 * Messages differ only where the action the user takes differs. An open failure and an unexpected exception share a
 * message because neither can be fixed through the link value. Outside the contract and not relative cannot arise
 * from document content and leave the user no action to take, so they are not notified.
 */
export const LINK_OPEN_FAILURE_MESSAGE_KEY: Readonly<Record<LinkOpenFailure, MessageKey | undefined>> = {
  [LINK_OPEN_FAILURE.outsideContract]: undefined,
  [LINK_OPEN_FAILURE.notRelative]: undefined,
  [LINK_OPEN_FAILURE.unresolvable]: 'relativeLink.unresolvable.message',
  [LINK_OPEN_FAILURE.outsideScope]: 'relativeLink.outsideScope.message',
  [LINK_OPEN_FAILURE.notFound]: 'relativeLink.notFound.message',
  [LINK_OPEN_FAILURE.notFile]: 'relativeLink.notFile.message',
  [LINK_OPEN_FAILURE.openFailed]: 'relativeLink.openFailed.message',
  [LINK_OPEN_FAILURE.unexpectedError]: 'relativeLink.openFailed.message',
};

// Descriptions for each failure reason. These records are only for maintainers, so they do not use a message catalog.
const FAILURE_DESCRIPTIONS: Record<LinkOpenFailure, string> = {
  [LINK_OPEN_FAILURE.outsideContract]: 'The received value is outside the contract',
  [LINK_OPEN_FAILURE.notRelative]: 'The href is not a relative file href',
  [LINK_OPEN_FAILURE.unresolvable]: 'The target path cannot be resolved',
  [LINK_OPEN_FAILURE.outsideScope]: 'The target is outside the permitted scope',
  [LINK_OPEN_FAILURE.notFound]: 'The target does not exist',
  [LINK_OPEN_FAILURE.notFile]: 'The target is not a file',
  [LINK_OPEN_FAILURE.openFailed]: 'The opening operation failed',
  [LINK_OPEN_FAILURE.unexpectedError]: 'An unexpected exception occurred',
};

/**
 * Formats a link-opening failure as one line for diagnostic records.
 *
 * The reason spelling begins the line. Its description may change for readability, but the spelling is stable like a
 * transmitted value, so the record uniquely identifies why opening failed. A cause does not create another line.
 *
 * @param failure The reason opening failed.
 * @param href The received href, or its type name if it is not a string.
 * @param cause A one-sentence cause, omitted when absent.
 * @returns One line for the diagnostic record.
 */
export function formatLinkOpenFailure(
  failure: LinkOpenFailure,
  href: string,
  cause?: string,
): string {
  // Both href and cause may contain newlines. The href is the element's attribute value, and the cause is exception text.
  // Quote and escape both so one record is not split across lines and remains traceable by line.
  const line = `[${failure}] Relative link: ${FAILURE_DESCRIPTIONS[failure]}: ${JSON.stringify(href)}`;
  return cause === undefined ? line : `${line} (${JSON.stringify(cause)})`;
}

/**
 * Reports a result where the link was not opened, depending on the reason, either to the diagnostic log only or as a
 * notification plus the diagnostic log.
 *
 * One call produces one log line and at most one notification. The notification receives only the message key; the
 * href and target path appear only in the log. VS Code notifications render `[text](command:…)` in the message as a
 * command link, so including document-derived values would let a document inject arbitrary command links into the
 * notification.
 *
 * @param failure The reason the link was not opened.
 * @param href The received href.
 * @param cause A one-sentence cause, or `undefined` when absent.
 * @param reporter The link failure reporter.
 */
export function reportLinkOpenFailure(
  failure: LinkOpenFailure,
  href: string,
  cause: string | undefined,
  reporter: LinkFailureReporter,
): void {
  const line = formatLinkOpenFailure(failure, href, cause);
  const key = LINK_OPEN_FAILURE_MESSAGE_KEY[failure];
  if (key === undefined) {
    reporter.reportInternalError(line);
    return;
  }
  // Passing the log line as the cause makes the error reporter write that line to the log and attach an action that
  // opens the log to the notification. Do not wait for the notification to close; waiting would make completion of
  // request handling depend on the user's action.
  void reporter.reportUserError(key, line);
}

/**
 * Handles a relative link request through revalidation, resolution, the scope check, the link target check, and the
 * opening operation, in that order.
 *
 * Later steps are not called once an earlier step fails. When the link is not opened, a single reason is chosen and
 * reported once. No failure throws outward, so other message handling in the same panel is not affected.
 *
 * @param href The href received in the request.
 * @param host Ports bound to the base document.
 * @param reporter The link failure reporter for results where the link was not opened.
 */
export async function openRelativeLink(
  href: string,
  host: RelativeLinkHost,
  reporter: LinkFailureReporter,
): Promise<void> {
  try {
    // Do not trust the view's decision; validate again with the same rule on the opening side.
    if (!isRelativeFileHref(href)) {
      reportLinkOpenFailure(LINK_OPEN_FAILURE.notRelative, href, undefined, reporter);
      return;
    }

    const targetPath = resolveTargetPath(href, host.documentPath);
    if (targetPath === undefined) {
      reportLinkOpenFailure(LINK_OPEN_FAILURE.unresolvable, href, undefined, reporter);
      return;
    }

    if (!isPathWithinScope(targetPath, host.documentPath, host.resolveScopeDepth())) {
      reportLinkOpenFailure(LINK_OPEN_FAILURE.outsideScope, href, undefined, reporter);
      return;
    }

    // Check the value that passed the scope check as is. Recreating it could make the checked target differ from the
    // target that was judged within scope.
    const check = await host.checkLinkTarget(targetPath);
    if (check.kind === 'notFound') {
      reportLinkOpenFailure(LINK_OPEN_FAILURE.notFound, href, undefined, reporter);
      return;
    }
    if (check.kind === 'notFile') {
      reportLinkOpenFailure(LINK_OPEN_FAILURE.notFile, href, check.entryType, reporter);
      return;
    }
    if (check.kind === 'openFailed') {
      reportLinkOpenFailure(LINK_OPEN_FAILURE.openFailed, href, check.cause, reporter);
      return;
    }

    // Pass through the value that passed validation. Recreating it here could make the opened target differ from the checked target.
    const attempt = await host.openLinkTarget(targetPath);
    if (!attempt.opened) {
      reportLinkOpenFailure(LINK_OPEN_FAILURE.openFailed, href, attempt.cause, reporter);
    }
  } catch (error) {
    reportLinkOpenFailure(LINK_OPEN_FAILURE.unexpectedError, href, String(error), reporter);
  }
}
