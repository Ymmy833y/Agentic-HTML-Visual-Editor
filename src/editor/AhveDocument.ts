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

  constructor(
    public readonly uri: vscode.Uri,
    pendingRestore: UnsavedBackup | undefined,
    private readonly onDispose?: () => void,
  ) {
    this.pendingRestore = pendingRestore;
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
    this.panel = undefined;
    this.onDispose?.();
  }
}
