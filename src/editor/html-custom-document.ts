import type * as vscode from 'vscode';
import type { LineEnding } from '../../common/index';
import { DocumentSyncState } from '../save/document-sync-state';

/** Receives retained copy and merge base changes and document disposal, to be forwarded to the backup. */
export interface BackupChangeListener {
  /** Called after the retained copy or the merge base changes. */
  onChange(): void;
  /** Called exactly once right before the document is disposed, while the retained copy is still readable. */
  onDispose(): void;
}

/**
 * The document for a single WYSIWYG tab.
 *
 * The workspace text buffer is the source of truth for the document body; this object never
 * owns that source of truth. Keeping two sources of truth would make which one to read depend
 * on the situation.
 *
 * The sync base needed as the common ancestor for save-time merges is a snapshot of the document
 * body, but it is not the source of truth. It is held here so that its lifetime is that of the
 * document rather than of a tab: recreating the view must not rewrite it.
 */
export class HtmlCustomDocument implements vscode.CustomDocument {
  readonly uri: vscode.Uri;
  /** The source file targeted by save, watching, reference resolution, and backup. Kept apart from the history `uri`. */
  readonly sourceUri: vscode.Uri;
  lineEnding: LineEnding = 'lf';

  /**
   * Sync state for this document.
   *
   * Returns the same instance when the view is recreated or the panel is replaced. Recreating it would incorrectly
   * treat unsaved edits still held by the view as already synchronized.
   */
  readonly syncState = new DocumentSyncState();

  // The complete document text most recently received from the view. Retain only the latest item,
  // without a history.
  private unsavedContent: string | undefined;

  private disposed = false;

  // Backup subscriptions. The document stays the same when the panel is recreated, so the document owns them and
  // releases them when it is disposed.
  private readonly backupListeners = new Set<BackupChangeListener>();

  private readonly unsubscribeMergeBase: () => void;

  constructor(uri: vscode.Uri, sourceUri: vscode.Uri = uri) {
    this.uri = uri;
    this.sourceUri = sourceUri;
    this.unsubscribeMergeBase = this.syncState.subscribeMergeBase(() => this.notifyBackupChange());
  }

  /**
   * The last known content, or `undefined` when none exists.
   *
   * It remains LF-delimited. The component that writes it back restores the file's line endings.
   */
  get lastKnownContent(): string | undefined {
    return this.unsavedContent;
  }

  /** Whether this document has been disposed. Used to decide whether a change event may be fired. */
  get isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * Subscribes to retained copy and merge base changes and to document disposal.
   *
   * @param listener The listener.
   * @returns A function that ends the subscription.
   */
  subscribeBackupChanges(listener: BackupChangeListener): () => void {
    this.backupListeners.add(listener);
    return () => {
      this.backupListeners.delete(listener);
    };
  }

  /**
   * Replaces the last known content with the received text.
   *
   * @param text The complete document text received from the view.
   */
  retainUnsavedContent(text: string): void {
    if (this.disposed) {
      return;
    }
    // Rewriting the backup when the same full text arrives again changes nothing and only adds writes.
    if (this.unsavedContent === text) {
      return;
    }
    this.unsavedContent = text;
    this.notifyBackupChange();
  }

  /**
   * Clears the last known content.
   *
   * This is called on the ack for a revert. It does not mark the document as disposed: the view is
   * still alive and keeps accepting messages.
   */
  clearUnsavedContent(): void {
    if (this.disposed) {
      return;
    }
    this.unsavedContent = undefined;
    // This only reports that there is no content; the backup side does not overwrite the existing backup with
    // empty content.
    this.notifyBackupChange();
  }

  /**
   * Discards the last known content and marks this document as disposed.
   *
   * This is called only when the panel is disposed, not when the view is recreated, so the content
   * to mount in a recreated view is not cleared here.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    // Notify before clearing the retained copy. Notifying afterwards would leave the side that decides whether to
    // keep a backup on close during protection unable to read the content.
    for (const listener of [...this.backupListeners]) {
      listener.onDispose();
    }
    this.backupListeners.clear();
    this.unsubscribeMergeBase();
    this.disposed = true;
    this.unsavedContent = undefined;
  }

  private notifyBackupChange(): void {
    for (const listener of [...this.backupListeners]) {
      listener.onChange();
    }
  }
}
