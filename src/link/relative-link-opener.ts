import { isRelativeFileHref, isRootRelativeFileHref } from '../../common/index';
import type { MessageKey } from '../../common/index';
import type { InternalErrorSink } from '../diagnostics/error-reporter';
import { isPathWithinScope, resolveScopeRootTargetPath, resolveTargetPath } from './link-path';

/**
 * Reasons a link was not opened.
 *
 * Each diagnostic log line carries this spelling as is, so the reasons are closed to these nine and no other value is
 * created.
 */
export const LINK_OPEN_FAILURE = {
  outsideContract: 'outsideContract',
  notRelative: 'notRelative',
  unresolvable: 'unresolvable',
  noWorkspaceFolder: 'noWorkspaceFolder',
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

/** Ports bound to the base document for the scope root depth and the link target check. */
export interface LinkResolveHost {
  /** The base document URI path, fixed when the ports are created and unaffected by request values. */
  readonly documentPath: string;

  /**
   * Returns whether the base document belongs to a workspace folder.
   *
   * Resolves it for every request because the workspace configuration may change while it remains open.
   */
  belongsToWorkspaceFolder(): boolean;

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
}

/** Ports bound to the base document that also open the target. */
export interface RelativeLinkHost extends LinkResolveHost {
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
  [LINK_OPEN_FAILURE.noWorkspaceFolder]: 'relativeLink.noWorkspaceFolder.message',
  [LINK_OPEN_FAILURE.outsideScope]: 'relativeLink.outsideScope.message',
  [LINK_OPEN_FAILURE.notFound]: 'relativeLink.notFound.message',
  [LINK_OPEN_FAILURE.notFile]: 'relativeLink.notFile.message',
  [LINK_OPEN_FAILURE.openFailed]: 'relativeLink.openFailed.message',
  [LINK_OPEN_FAILURE.unexpectedError]: 'relativeLink.openFailed.message',
};

// Descriptions for each failure reason. These records are only for maintainers, so they do not use a message catalog.
const FAILURE_DESCRIPTIONS: Record<LinkOpenFailure, string> = {
  [LINK_OPEN_FAILURE.outsideContract]: 'The received value is outside the contract',
  [LINK_OPEN_FAILURE.notRelative]: 'The href is neither a relative nor a root-relative file href',
  [LINK_OPEN_FAILURE.unresolvable]: 'The target path cannot be resolved',
  [LINK_OPEN_FAILURE.noWorkspaceFolder]: 'The root-relative href has no workspace folder to resolve from',
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
 * Returns the scope-root reading of an href when it is a different, in-scope target.
 *
 * @param href The href received in the request.
 * @param host Ports bound to the base document.
 * @param scopeDepth The depth of the scope root.
 * @param targetPath The document-relative target path already checked.
 * @returns The target path resolved against the scope root, or `undefined` when there is no other candidate.
 */
function findScopeRootTarget(
  href: string,
  host: LinkResolveHost,
  scopeDepth: number,
  targetPath: string,
): string | undefined {
  const rootTargetPath = resolveScopeRootTargetPath(href, host.documentPath, scopeDepth);
  if (rootTargetPath === undefined || rootTargetPath === targetPath) {
    return undefined;
  }
  // Check the candidate with the same rule. A `..` in the href can climb out of the root as well.
  return isPathWithinScope(rootTargetPath, host.documentPath, scopeDepth) ? rootTargetPath : undefined;
}

/** The file a link leads to, or the single reason it leads to none. */
export type LinkResolution =
  | { readonly resolved: true; readonly targetPath: string }
  | { readonly resolved: false; readonly failure: LinkOpenFailure; readonly cause?: string };

/**
 * Decides which file an href leads to through revalidation, resolution, the scope check and the link target check, in
 * that order.
 *
 * A target not found from the document directory is looked up once more from the scope root, so a link written from
 * the project root also leads somewhere. A root-relative href resolves from the workspace folder from the start, so it
 * has no second lookup. Later steps are not called once an earlier step fails. It is shared by opening a link in the
 * editor and by writing a link into an exported PDF, so the two never disagree about where a link goes.
 *
 * Never throws and never rejects; an exception from the ports becomes the unexpected error reason.
 *
 * @param href The href as written.
 * @param host Ports bound to the base document.
 * @returns The target path that passed every check, or the reason it did not.
 */
export async function resolveLinkTarget(href: string, host: LinkResolveHost): Promise<LinkResolution> {
  const fail = (failure: LinkOpenFailure, cause?: string): LinkResolution => (
    cause === undefined ? { resolved: false, failure } : { resolved: false, failure, cause }
  );
  try {
    // Do not trust the view's decision; validate again with the same rule on this side.
    const rootRelative = isRootRelativeFileHref(href);
    if (!rootRelative && !isRelativeFileHref(href)) {
      return fail(LINK_OPEN_FAILURE.notRelative);
    }

    // A root-relative href names a path from the workspace folder. Resolving it from the document directory instead
    // could open a file the author did not mean, so a document outside every workspace folder does not open it.
    if (rootRelative && !host.belongsToWorkspaceFolder()) {
      return fail(LINK_OPEN_FAILURE.noWorkspaceFolder);
    }

    // In a workspace folder, the scope root is that folder, so a root-relative href resolves from the scope root.
    const rootScopeDepth = rootRelative ? host.resolveScopeDepth() : undefined;
    const targetPath = rootScopeDepth === undefined
      ? resolveTargetPath(href, host.documentPath)
      : resolveScopeRootTargetPath(href, host.documentPath, rootScopeDepth);
    if (targetPath === undefined) {
      return fail(LINK_OPEN_FAILURE.unresolvable);
    }

    const scopeDepth = rootScopeDepth ?? host.resolveScopeDepth();
    if (!isPathWithinScope(targetPath, host.documentPath, scopeDepth)) {
      return fail(LINK_OPEN_FAILURE.outsideScope);
    }

    // Check the value that passed the scope check as is. Recreating it could make the checked target differ from the
    // target that was judged within scope.
    const check = await host.checkLinkTarget(targetPath);
    if (check.kind === 'notFound') {
      // A link written from the scope root does not resolve from the document directory. Try that reading next, and
      // take it only when it is a file; otherwise the document-relative reading stays the reported one. A
      // root-relative href was already read from the scope root.
      const rootTargetPath = rootRelative ? undefined : findScopeRootTarget(href, host, scopeDepth, targetPath);
      if (rootTargetPath === undefined || (await host.checkLinkTarget(rootTargetPath)).kind !== 'file') {
        return fail(LINK_OPEN_FAILURE.notFound);
      }
      return { resolved: true, targetPath: rootTargetPath };
    }
    if (check.kind === 'notFile') {
      return fail(LINK_OPEN_FAILURE.notFile, check.entryType);
    }
    if (check.kind === 'openFailed') {
      return fail(LINK_OPEN_FAILURE.openFailed, check.cause);
    }
    return { resolved: true, targetPath };
  } catch (error) {
    return fail(LINK_OPEN_FAILURE.unexpectedError, String(error));
  }
}

/**
 * Handles a relative link request: decides the target with {@link resolveLinkTarget}, then opens it.
 *
 * When the link is not opened, a single reason is chosen and reported once. No failure throws outward, so other
 * message handling in the same panel is not affected.
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
    const resolution = await resolveLinkTarget(href, host);
    if (!resolution.resolved) {
      reportLinkOpenFailure(resolution.failure, href, resolution.cause, reporter);
      return;
    }

    // Pass through the value that passed validation. Recreating it here could make the opened target differ from the checked target.
    const attempt = await host.openLinkTarget(resolution.targetPath);
    if (!attempt.opened) {
      reportLinkOpenFailure(LINK_OPEN_FAILURE.openFailed, href, attempt.cause, reporter);
    }
  } catch (error) {
    reportLinkOpenFailure(LINK_OPEN_FAILURE.unexpectedError, href, String(error), reporter);
  }
}
