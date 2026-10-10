import type * as vscode from 'vscode';

import type { InternalErrorSink } from '../diagnostics/error-reporter';
import type { HtmlCustomDocument } from '../editor/html-custom-document';
import { WysiwygSession } from './wysiwyg-session';

/** A value snapshot of the session registry contents that excludes webview panels. */
export interface SessionInspection {
  /** The URI strings of the registered documents. */
  readonly documentUris: readonly string[];
  /** The active session's document URI string, or `undefined` when there is no target. */
  readonly activeDocumentUri: string | undefined;
}

/**
 * A session registry that holds open WYSIWYG sessions and provides the active session.
 */
export class SessionRegistry {
  private readonly sessions = new Map<string, WysiwygSession>();

  private activeSession: WysiwygSession | undefined;

  /**
   * Receives and retains the internal error sink.
   *
   * @param errorSink The sink that records replaced registrations in the diagnostic log.
   */
  constructor(private readonly errorSink: InternalErrorSink) {}

  /**
   * Registers a document and webview panel as a session, then subscribes to active-state changes and disposal.
   *
   * @param document The target document.
   * @param panel The webview panel attached to the document. It must already be configured and populated.
   * @returns The registered session, to which the caller can add subscriptions.
   */
  register(document: HtmlCustomDocument, panel: vscode.WebviewPanel): WysiwygSession {
    const key = document.sourceUri.toString();
    // Multiple editors for one document are disabled, so normal operations do not reach this path.
    // Reaching it indicates missed cleanup. Silently overwriting the entry would leave nobody responsible
    // for disposing the remaining subscriptions and webview panel.
    if (this.sessions.has(key)) {
      // The user cannot act on this, but without a diagnostic log entry, the missed cleanup itself
      // would go unnoticed. Normal cleanup on panel disposal does not take this branch, so only an
      // abnormal condition reaches it.
      this.errorSink.reportInternalError(`Replaced an existing session registration: ${key}`);
    }
    this.unregister(key);

    const session = new WysiwygSession(document, panel);
    this.sessions.set(key, session);

    session.addSubscription(
      panel.onDidChangeViewState((event) => this.handleViewStateChange(event, session)),
    );
    // Keep webview panel disposal as the sole trigger for unregistration. Multiple triggers could either
    // leave a registration behind on a path that hits only one trigger or remove a live panel's registration.
    // Closing the tab, editor group, or window all reaches this handler.
    session.addSubscription(panel.onDidDispose(() => this.unregister(key)));

    if (panel.active) {
      this.activeSession = session;
    }

    return session;
  }

  /**
   * Returns the target session.
   *
   * @returns The active session, or `undefined` when there is none. Having no target is an ordinary state
   * when no WYSIWYG editor is open or the user is working in another editor. The caller decides whether to notify.
   */
  getActiveSession(): WysiwygSession | undefined {
    return this.activeSession;
  }

  /**
   * Finds a session by document URI.
   *
   * The key is the canonical form the URI returned when the session was registered. Nothing is
   * normalized here, so the caller aligns the URI with that same canonical form before passing it in.
   *
   * @param documentUri The string representation of the document URI.
   * @returns The matching session, or `undefined` if none exists.
   */
  findSession(documentUri: string): WysiwygSession | undefined {
    return this.sessions.get(documentUri);
  }

  /**
   * Returns a value snapshot of the session registry contents for integration-test inspection.
   *
   * @returns The registered document URI strings and the active session's document URI string.
   */
  readInspection(): SessionInspection {
    // Copy the current values so the snapshot does not change when registrations change after this call.
    return {
      documentUris: [...this.sessions.keys()],
      activeDocumentUri: this.activeSession?.documentUri.toString(),
    };
  }

  /** Unregisters every session. Called when the extension shuts down. */
  dispose(): void {
    for (const key of [...this.sessions.keys()]) {
      this.unregister(key);
    }
  }

  /**
   * Reflects changes to a webview panel's active state in the active-session reference.
   *
   * When the webview panel that became inactive is the current target, clear the target instead of falling
   * back to the most recently active session. Falling back would apply commands to a tab the user cannot see.
   */
  private handleViewStateChange(
    event: vscode.WebviewPanelOnDidChangeViewStateEvent,
    session: WysiwygSession,
  ): void {
    if (event.webviewPanel.active) {
      this.activeSession = session;
      return;
    }

    if (this.activeSession === session) {
      this.activeSession = undefined;
    }
  }

  /**
   * Removes the registration, active-session reference, and stored subscriptions for the specified key.
   *
   * This remains private so webview panel disposal is the sole trigger for unregistration. If the active-session
   * reference retained a disposed panel, the next command would select it and fail by sending to a missing recipient.
   */
  private unregister(key: string): void {
    const session = this.sessions.get(key);
    if (session === undefined) {
      return;
    }

    this.sessions.delete(key);
    if (this.activeSession === session) {
      this.activeSession = undefined;
    }
    session.dispose();
  }
}
