import type * as vscode from 'vscode';
import type { UnsavedBackup } from './backup';
import type { ExtensionToWebviewMessage, SerializedSelection } from '../shared/messages';

/** Snapshot of the view returned by a `getFileData` round-trip. */
export interface ViewFileData {
  /** Current view serialization, or null when the view is unreachable. */
  html: string | null;
  /** The document text the view last synced from, or null with `html`. */
  baseHtml: string | null;
}

/**
 * Custom document backing a WYSIWYG editor tab. It owns no content of its
 * own — the text buffer stays the source of truth and the live edits stay in
 * the webview — but it carries the per-document state the provider needs:
 * dirty bookkeeping hooks, the save serialization chain, and the freshest
 * unsaved view content for backups and save fallbacks.
 */
export class AhveDocument implements vscode.CustomDocument {
  /**
   * Unsaved content to restore into the next view session, recovered from a
   * hot-exit backup (or the legacy workspaceState backup). Consumed by the
   * first `ready` message.
   */
  public pendingRestore: UnsavedBackup | undefined;

  /**
   * Freshest unsaved view content, fed by the webview's debounced `backup`
   * stream (flushed on unload). Source for `backupCustomDocument` and the
   * save fallback when the webview cannot answer a `getFileData` request.
   */
  public lastKnown: UnsavedBackup | undefined;

  /**
   * Saves are serialized through a promise chain: two overlapping saves would
   * otherwise both read a stale text-buffer state as their merge input.
   */
  public saveChain: Promise<void> = Promise.resolve();

  /**
   * Set while a save applies its merge to the text buffer, so the resulting
   * onDidChangeTextDocument is not echoed back to the view as an external
   * change.
   */
  public suppressEcho = false;

  /** The panel showing this document (at most one per document). */
  public panel: vscode.WebviewPanel | undefined;

  private readonly pendingRequests = new Map<number, (data: ViewFileData) => void>();
  private readonly pendingHistoryApplies = new Map<number, () => void>();
  private readonly pendingHistoryFlushes = new Map<number, () => void>();
  private nextRequestId = 1;

  /** Resolves when the current view has completed its `ready` → `init` handshake. */
  private viewReady: Promise<void>;
  private resolveViewReady: () => void = () => undefined;

  constructor(
    public readonly uri: vscode.Uri,
    pendingRestore: UnsavedBackup | undefined,
    private readonly onDispose?: () => void,
  ) {
    this.pendingRestore = pendingRestore;
    this.viewReady = this.armViewReady();
  }

  private armViewReady(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.resolveViewReady = resolve;
    });
  }

  /**
   * Re-arms the readiness gate. Called whenever a panel is resolved: moving or
   * reloading a panel recreates its webview, which redoes the handshake.
   */
  public resetViewReady(): void {
    this.viewReady = this.armViewReady();
  }

  /** The host has answered the view's `ready` with `init`; the view is usable. */
  public markViewReady(): void {
    this.resolveViewReady();
  }

  /**
   * Resolves once the view has been initialized. Resolves right away when there
   * is no panel (nothing to wait for), and after `timeoutMs` when the handshake
   * never completes (webview blocked or torn down) so no caller hangs on it.
   */
  public whenViewReady(timeoutMs = 10000): Promise<void> {
    if (!this.panel) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      void this.viewReady.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /**
   * Posts `message` once the view has finished its handshake. A message that
   * overtakes `init` reaches a view whose sync state is not set up yet: the edit
   * it triggers has no baseline and is dropped, and the `init` that follows
   * remounts the document over it. Returns whether there is a live panel at all.
   */
  public postWhenViewReady(message: ExtensionToWebviewMessage): boolean {
    const panel = this.panel;
    if (!panel) return false;
    void this.whenViewReady().then(() => {
      // The panel may have been replaced or disposed while the gate was closed.
      if (this.panel !== panel) return;
      void panel.webview.postMessage(message);
    });
    return true;
  }

  /**
   * Ask the webview for its current serialization. Resolves with nulls when
   * there is no live panel or the view does not answer within `timeoutMs`
   * (webview still booting, blocked, or already torn down).
   */
  public requestFileData(timeoutMs = 2000, forHistory = false): Promise<ViewFileData> {
    const panel = this.panel;
    if (!panel) return Promise.resolve({ html: null, baseHtml: null });
    const requestId = this.nextRequestId++;
    return new Promise<ViewFileData>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        resolve({ html: null, baseHtml: null });
      }, timeoutMs);
      this.pendingRequests.set(requestId, (data) => {
        clearTimeout(timer);
        this.pendingRequests.delete(requestId);
        resolve(data);
      });
      void panel.webview.postMessage({
        type: 'getFileData',
        requestId,
        forHistory,
      } satisfies ExtensionToWebviewMessage);
    });
  }

  /** Complete the pending `getFileData` request carrying `requestId`. */
  public resolveFileData(requestId: number, data: ViewFileData): void {
    this.pendingRequests.get(requestId)?.(data);
  }

  /** Apply an undo/redo result in the live view and wait until it is mounted. */
  public applyHistoryState(
    html: string,
    selection: SerializedSelection | null,
    timeoutMs = 2000,
  ): Promise<void> {
    const panel = this.panel;
    if (!panel) return Promise.resolve();
    const requestId = this.nextRequestId++;
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingHistoryApplies.delete(requestId);
        resolve();
      }, timeoutMs);
      this.pendingHistoryApplies.set(requestId, () => {
        clearTimeout(timer);
        this.pendingHistoryApplies.delete(requestId);
        resolve();
      });
      void panel.webview.postMessage({
        type: 'applyHistoryState',
        requestId,
        html,
        selection,
      } satisfies ExtensionToWebviewMessage);
    });
  }

  public resolveHistoryApply(requestId: number): void {
    this.pendingHistoryApplies.get(requestId)?.();
  }

  /** Commit any grouped native input before VS Code traverses its edit stack. */
  public flushHistory(timeoutMs = 2000): Promise<void> {
    const panel = this.panel;
    if (!panel) return Promise.resolve();
    const requestId = this.nextRequestId++;
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingHistoryFlushes.delete(requestId);
        resolve();
      }, timeoutMs);
      this.pendingHistoryFlushes.set(requestId, () => {
        clearTimeout(timer);
        this.pendingHistoryFlushes.delete(requestId);
        resolve();
      });
      void panel.webview.postMessage({
        type: 'flushHistory',
        requestId,
      } satisfies ExtensionToWebviewMessage);
    });
  }

  public resolveHistoryFlush(requestId: number): void {
    this.pendingHistoryFlushes.get(requestId)?.();
  }

  public dispose(): void {
    for (const resolve of this.pendingRequests.values()) {
      resolve({ html: null, baseHtml: null });
    }
    this.pendingRequests.clear();
    for (const resolve of this.pendingHistoryApplies.values()) resolve();
    this.pendingHistoryApplies.clear();
    for (const resolve of this.pendingHistoryFlushes.values()) resolve();
    this.pendingHistoryFlushes.clear();
    // Release anyone waiting on the handshake instead of making them sit out the
    // timeout; they check the panel identity before doing anything.
    this.resolveViewReady();
    this.panel = undefined;
    this.onDispose?.();
  }
}
