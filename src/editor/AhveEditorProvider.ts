import * as vscode from 'vscode';
import { CUSTOM_EDITOR_VIEW_TYPE } from '../constants';
import { AhveDocument } from './AhveDocument';
import { computeInitPayload, type UnsavedBackup } from './backup';
import { readBackupFile, writeBackupFile } from './backupFile';
import { buildContentSecurityPolicy } from './csp';
import { saveAfterFlush } from './document-actions';
import { mergeHtml } from './merge';
import { mergeHistoryTransition } from './history';
import { openRelativeFileLink } from './relativeFileLinks';
import type { AhveSessionRegistry } from './session-registry';
import type {
  ExtensionToWebviewMessage,
  SerializedEditState,
  WebviewToExtensionMessage,
} from '../shared/messages';

// The workspaceState key that held the latest unsaved view content per document
// before backups moved to VSCode's native custom-editor backup mechanism. It is
// still read (once) so that unsaved content produced by an earlier version of
// the extension is not lost across an update.
const LEGACY_BACKUP_KEY_PREFIX = 'ahve.unsavedBackup:';

function legacyBackupKey(uri: vscode.Uri): string {
  return LEGACY_BACKUP_KEY_PREFIX + uri.toString();
}

// The WYSIWYG editor is implemented as a full CustomEditorProvider rather than a
// CustomTextEditorProvider so that the tab's dirty indicator is independent of the
// text buffer: WYSIWYG edits stay inside the Webview until a save, and the tab's ●
// is driven by onDidChangeCustomDocument rather than by the TextDocument's dirty
// state. The sync target is still the TextDocument — a save three-way merges the
// view back into the buffer — so the text editor and the WYSIWYG view keep seeing
// each other's changes.
export class AhveEditorProvider implements vscode.CustomEditorProvider<AhveDocument> {
  public static readonly viewType = CUSTOM_EDITOR_VIEW_TYPE;

  private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<
    vscode.CustomDocumentEditEvent<AhveDocument>
  >();

  // Every WYSIWYG transaction is a native custom-editor edit. VS Code manages the
  // stack traversal and the saved marker, and the callbacks mount the corresponding
  // visual state back into the Webview.
  public readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly sessions: AhveSessionRegistry,
  ) {}

  public static register(
    context: vscode.ExtensionContext,
    sessions: AhveSessionRegistry,
  ): {
    registration: vscode.Disposable;
    provider: AhveEditorProvider;
  } {
    const provider = new AhveEditorProvider(context, sessions);
    const registration = vscode.window.registerCustomEditorProvider(
      AhveEditorProvider.viewType,
      provider,
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      },
    );
    return { registration, provider };
  }

  /**
   * Test hook: pushes a reversible, no-op WYSIWYG transaction. Integration tests
   * cannot reach the Webview DOM, so they cannot produce a real edit.
   */
  public fireTestEdit(uri: vscode.Uri): boolean {
    const document = this.sessions.find(uri);
    if (!document) return false;
    this._onDidChangeCustomDocument.fire({
      document,
      label: 'Test WYSIWYG edit',
      undo: () => undefined,
      redo: () => undefined,
    });
    return true;
  }

  public setTestViewHtml(uri: vscode.Uri, html: string): boolean {
    const document = this.sessions.find(uri);
    if (!document?.panel) return false;
    void document.panel.webview.postMessage({ type: 'testSetHtml', html });
    return true;
  }

  public async getTestViewHtml(uri: vscode.Uri): Promise<string | null> {
    const document = this.sessions.find(uri);
    if (!document) return null;
    return (await document.requestFileData()).html;
  }

  public requestTestViewSave(uri: vscode.Uri): boolean {
    const document = this.sessions.find(uri);
    if (!document?.panel) return false;
    void document.panel.webview.postMessage({ type: 'testRequestSave' });
    return true;
  }

  public openTestRelativeFile(uri: vscode.Uri, href: string): Promise<boolean> {
    return openRelativeFileLink(uri, href);
  }

  /**
   * Test hook: makes the Webview post an `openRelativeFile` message, so the host's
   * message handler (not just `openRelativeFileLink`) is exercised end to end with
   * the real document uri.
   */
  public openTestRelativeFileViaWebview(uri: vscode.Uri, href: string): boolean {
    const document = this.sessions.find(uri);
    if (!document?.panel) return false;
    void document.panel.webview.postMessage({ type: 'testOpenRelativeFile', href });
    return true;
  }

  public async openCustomDocument(
    uri: vscode.Uri,
    openContext: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken,
  ): Promise<AhveDocument> {
    let restore: UnsavedBackup | undefined;
    if (openContext.backupId) {
      restore = await readBackupFile(vscode.Uri.parse(openContext.backupId));
    }
    if (!restore) {
      // One-time migration of a backup persisted by an earlier version of the
      // extension (workspaceState based).
      const key = legacyBackupKey(uri);
      const legacy = this.context.workspaceState.get<UnsavedBackup>(key);
      if (legacy) {
        restore = legacy;
        await this.context.workspaceState.update(key, undefined);
      }
    }
    const document = new AhveDocument(uri, restore, () => this.sessions.remove(document));
    this.sessions.add(document);
    return document;
  }

  public resolveCustomEditor(
    document: AhveDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): void {
    document.panel = webviewPanel;

    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: buildLocalResourceRoots(this.context.extensionUri, document.uri),
    };

    const fileName = document.uri.path.split('/').at(-1) ?? '';
    webviewPanel.title = `${fileName} (WYSIWYG)`;
    webviewPanel.iconPath = {
      light: vscode.Uri.joinPath(this.context.extensionUri, 'icons', 'ahve-light.svg'),
      dark: vscode.Uri.joinPath(this.context.extensionUri, 'icons', 'ahve-dark.svg'),
    };
    webviewPanel.webview.html = this.getHtml(webviewPanel.webview, document.uri);

    this.sessions.setActivePanel(webviewPanel);

    const post = (message: ExtensionToWebviewMessage): void => {
      void webviewPanel.webview.postMessage(message);
    };

    const messageSubscription = webviewPanel.webview.onDidReceiveMessage(
      async (message: WebviewToExtensionMessage) => {
        switch (message.type) {
          case 'ready': {
            // Restore unsaved changes either from a hot-exit backup (consumed
            // here) or from the latest content streamed by a previous Webview
            // (moving or reloading a panel recreates the Webview). If the
            // document changed in the meantime, what gets restored is the
            // three-way merge with that change.
            const backup = document.pendingRestore ?? document.lastKnown;
            document.pendingRestore = undefined;
            const docText =
              (await readOpenDocumentOrFile(document.uri)) ?? backup?.baseHtml ?? '';
            const payload = computeInitPayload(docText, backup);
            if (payload.restored !== undefined) {
              // A restored view is already dirty before any edit streams new
              // content. Seed the backup source up front so hot exit has
              // something to persist.
              document.lastKnown = { baseHtml: docText, html: payload.restored };
            } else {
              // A stale or already-saved backup: just consume it.
              document.lastKnown = undefined;
            }
            post({ type: 'init', html: payload.html, restored: payload.restored });
            break;
          }
          case 'editCommitted': {
            const { before, after } = message;
            this._onDidChangeCustomDocument.fire({
              document,
              label: message.label,
              undo: () => this.applyHistoryTransition(document, after, before),
              redo: () => this.applyHistoryTransition(document, before, after),
            });
            break;
          }
          case 'historyStateApplied':
            document.resolveHistoryApply(message.requestId);
            break;
          case 'historyFlushed':
            document.resolveHistoryFlush(message.requestId);
            break;
          case 'requestSave': {
            // The request comes from the active WYSIWYG Webview. When an HTML
            // text tab for the same resource is also open, saving by URI is
            // ambiguous: VS Code may save the stale TextDocument first and then
            // be unable to reflect the custom editor's subsequent write. Save
            // the active editor exactly once instead.
            await saveAfterFlush(document);
            break;
          }
          case 'fileData':
            document.resolveFileData(message.requestId, {
              html: message.html,
              baseHtml: message.baseHtml,
            });
            break;
          case 'backup':
            document.lastKnown = { baseHtml: message.baseHtml, html: message.html };
            break;
          case 'openRelativeFile':
            await openRelativeFileLink(document.uri, message.href);
            break;
          case 'clipboardWrite':
            await writeClipboard(message.text);
            break;
        }
      },
    );

    const documentChangeSubscription = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== document.uri.toString()) return;
      if (document.suppressEcho) return;
      post({ type: 'documentChanged', html: e.document.getText() });
    });

    // Watch disk changes without holding a TextDocument. Keeping an invisible text
    // model open would let a filesystem save create/replace an undo element on the
    // same URI as the custom editor, collapsing the visual undo after a save. Real
    // text tabs are still handled by the onDidChangeTextDocument above.
    const fileWatcher = createDocumentWatcher(document.uri, async () => {
      if (document.suppressEcho) return;
      const html = await readFileText(document.uri);
      if (html !== undefined) post({ type: 'documentChanged', html });
    });

    const viewStateSubscription = webviewPanel.onDidChangeViewState(() => {
      if (webviewPanel.active) {
        this.sessions.setActivePanel(webviewPanel);
      } else {
        this.sessions.clearActivePanel(webviewPanel);
      }
    });

    webviewPanel.onDidDispose(() => {
      this.sessions.clearActivePanel(webviewPanel);
      if (document.panel === webviewPanel) {
        document.panel = undefined;
      }
      messageSubscription.dispose();
      documentChangeSubscription.dispose();
      fileWatcher?.dispose();
      viewStateSubscription.dispose();
    });
  }

  private async applyHistoryTransition(
    document: AhveDocument,
    from: SerializedEditState,
    to: SerializedEditState,
  ): Promise<void> {
    const current = await document.requestFileData(2000, true);
    const html =
      current.html === null
        ? to.html
        : mergeHistoryTransition(from.html, to.html, current.html);
    if (current.baseHtml !== null) {
      document.lastKnown = { baseHtml: current.baseHtml, html };
    }
    await document.applyHistoryState(html, to.selection);
  }

  public saveCustomDocument(
    document: AhveDocument,
    _token: vscode.CancellationToken,
  ): Thenable<void> {
    // Serialize saves per document: the merge input (the buffer's text) must not be
    // made stale by an overlapping save. Keep the chain alive after a failed save so
    // that subsequent saves still run.
    const run = document.saveChain.then(() => this.performSave(document));
    document.saveChain = run.catch(() => undefined);
    return run;
  }

  private async performSave(document: AhveDocument): Promise<void> {
    const post = (message: ExtensionToWebviewMessage): void => {
      void document.panel?.webview.postMessage(message);
    };

    let view = await document.requestFileData();
    if (view.html === null || view.baseHtml === null) {
      // The Webview is unreachable (starting up, blocked, or disposed): fall back
      // to the latest content it streamed.
      const fallback = document.lastKnown;
      if (fallback) view = { html: fallback.html, baseHtml: fallback.baseHtml };
    }

    const textDoc = findOpenTextDocument(document.uri);
    let documentText = textDoc?.getText() ?? (await readFileText(document.uri));
    if (documentText === undefined) {
      // The file is gone from disk and no buffer is left: rebuild the file from the
      // view's content rather than lose the edits.
      if (view.html !== null) {
        await vscode.workspace.fs.writeFile(document.uri, new TextEncoder().encode(view.html));
        document.lastKnown = undefined;
        post({ type: 'saveResult', html: view.html, ok: true });
      }
      return;
    }

    if (view.html === null || view.baseHtml === null) {
      // There is no WYSIWYG content to merge. Behave like an ordinary save of the
      // buffer, but still return a saveResult so that a slow view which answered the
      // snapshot request after the timeout can settle its pending internal state.
      if (textDoc) await textDoc.save();
      post({ type: 'saveResult', html: textDoc?.getText() ?? documentText, ok: true });
      return;
    }

    // Commit the text tab's unsaved edits first, so they take part in the three-way
    // merge below. Saving before the merge also lets the ordinary text save
    // participants run without turning the WYSIWYG result itself into a TextDocument
    // undo element.
    if (textDoc?.isDirty) {
      const textSaved = await textDoc.save();
      if (!textSaved && textDoc.isDirty) {
        post({ type: 'saveResult', html: textDoc.getText(), ok: false });
        throw new Error('Saving the HTML text document failed.');
      }
      documentText = textDoc.getText();
    }

    // Persist the merged WYSIWYG result directly through the filesystem. Applying a
    // WorkspaceEdit here would add a whole-document replacement to the undo stack of
    // the same URI that CustomDocumentEditEvent uses, and the first undo after a save
    // would then consume that replacement instead of the last visual edit.
    const merged = normalizeEol(
      mergeHtml(view.baseHtml, view.html, documentText),
      textDoc?.eol ?? detectEndOfLine(documentText),
    );
    document.suppressEcho = true;
    try {
      // The filesystem write is the durability boundary. VS Code may later reload an
      // inactive, clean HTML tab, but that UI refresh must never turn a successful
      // disk write into a failed WYSIWYG save.
      await vscode.workspace.fs.writeFile(document.uri, new TextEncoder().encode(merged));
    } catch (error) {
      vscode.window.showErrorMessage(
        'Could not save the WYSIWYG changes to the document; the file was not saved.',
      );
      post({ type: 'saveResult', html: textDoc?.getText() ?? documentText, ok: false });
      throw error;
    } finally {
      document.suppressEcho = false;
    }
    // The unsaved changes reached the file, so drop their backup source.
    document.lastKnown = undefined;
    // Return the post-save authoritative text so the Webview can update its sync
    // baseline (save hooks such as formatting or trailing-newline insertion may have
    // adjusted the text).
    post({ type: 'saveResult', html: merged, ok: true });
  }

  public async saveCustomDocumentAs(
    document: AhveDocument,
    destination: vscode.Uri,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    let view = await document.requestFileData();
    if (view.html === null || view.baseHtml === null) {
      const fallback = document.lastKnown;
      if (fallback) view = { html: fallback.html, baseHtml: fallback.baseHtml };
    }
    let content: string;
    if (view.html !== null && view.baseHtml !== null) {
      const buffer = await readOpenDocumentOrFile(document.uri);
      content = buffer === undefined ? view.html : mergeHtml(view.baseHtml, view.html, buffer);
    } else {
      content = (await readOpenDocumentOrFile(document.uri)) ?? '';
    }
    // Leave the original buffer untouched. VSCode reopens the editor on the
    // destination resource (a fresh openCustomDocument call).
    await vscode.workspace.fs.writeFile(destination, new TextEncoder().encode(content));
  }

  public async revertCustomDocument(
    document: AhveDocument,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    // Revert to the text *buffer*, not the file on disk: the merge invariant is
    // "baseHtml === the buffer's content as of the last sync", and a text tab's
    // unsaved edits must survive a WYSIWYG revert (they are not this editor's
    // changes).
    const html = (await readOpenDocumentOrFile(document.uri)) ?? '';
    document.pendingRestore = undefined;
    document.lastKnown = undefined;
    void document.panel?.webview.postMessage({
      type: 'revert',
      html,
    } satisfies ExtensionToWebviewMessage);
  }

  public async backupCustomDocument(
    document: AhveDocument,
    context: vscode.CustomDocumentBackupContext,
    _token: vscode.CancellationToken,
  ): Promise<vscode.CustomDocumentBackup> {
    // `lastKnown` is fed by the Webview's debounced backup stream (flushed on
    // unload) and is also seeded on restore, so it is always current while the
    // document is dirty. Throwing makes VSCode keep this document's previous
    // backup.
    const data = document.lastKnown;
    if (!data) {
      throw new Error('No unsaved WYSIWYG content to back up.');
    }
    await writeBackupFile(context.destination, data);
    return {
      id: context.destination.toString(),
      delete: (): void => {
        // Best effort: the backup file may already be gone.
        void vscode.workspace.fs.delete(context.destination).then(undefined, () => undefined);
      },
    };
  }

  private getHtml(webview: vscode.Webview, documentUri: vscode.Uri): string {
    const nonce = makeNonce();
    const cspSource = webview.cspSource;
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js'),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.css'),
    );

    // Resolve relative resource paths in the rendered content (e.g.
    // `<img src="./images/foo.png">`) against the document's own directory. The
    // Webview runs on a `vscode-webview://` origin, so without a <base> every
    // relative URL resolves against that origin and local images do not load. Only
    // file documents have a meaningful directory on disk, so other schemes (untitled
    // and the like) get no <base> and keep their previous behavior. Browsers use the
    // base only for URL resolution at fetch time — the `src` attribute string itself
    // is unchanged, so serialization and round-tripping are unaffected.
    const baseTag =
      documentUri.scheme === 'file'
        ? `\n    <base href="${webview
            .asWebviewUri(vscode.Uri.joinPath(documentUri, '..'))
            .toString()}/" />`
        : '';

    const csp = buildContentSecurityPolicy(cspSource, nonce);

    return /* html */ `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />${baseTag}
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <link rel="stylesheet" href="${styleUri.toString()}" />
    <title>Agentic HTML Visual Editor</title>
  </head>
  <body>
    <div id="ahve-root" role="document"></div>
    <script nonce="${nonce}" src="${scriptUri.toString()}"></script>
  </body>
</html>`;
  }
}

// The resource roots the Webview may load local files (images, fonts) from. Always
// includes the extension's `dist` bundle. For file documents it also allows the
// document's own directory (so `./…` image paths load) and the workspace folder that
// contains it (so `../…` paths that stay inside the workspace load too). Absolute
// paths and paths outside the workspace are deliberately left unreachable.
function buildLocalResourceRoots(
  extensionUri: vscode.Uri,
  documentUri: vscode.Uri,
): vscode.Uri[] {
  const roots = [vscode.Uri.joinPath(extensionUri, 'dist')];
  if (documentUri.scheme === 'file') {
    roots.push(vscode.Uri.joinPath(documentUri, '..'));
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(documentUri);
    if (workspaceFolder) {
      roots.push(workspaceFolder.uri);
    }
  }
  return roots;
}

/** Whether the WYSIWYG tab for `uri` currently shows the dirty indicator. */
function findOpenTextDocument(uri: vscode.Uri): vscode.TextDocument | undefined {
  return vscode.workspace.textDocuments.find(
    (candidate) => candidate.uri.toString() === uri.toString(),
  );
}

async function readOpenDocumentOrFile(uri: vscode.Uri): Promise<string | undefined> {
  return findOpenTextDocument(uri)?.getText() ?? readFileText(uri);
}

async function readFileText(uri: vscode.Uri): Promise<string | undefined> {
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return undefined;
  }
}

function createDocumentWatcher(
  uri: vscode.Uri,
  onChange: () => void | Promise<void>,
): vscode.FileSystemWatcher | undefined {
  if (uri.scheme !== 'file') return undefined;
  const fileName = uri.path.split('/').at(-1);
  if (!fileName) return undefined;
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.joinPath(uri, '..'), fileName),
  );
  watcher.onDidChange(() => void onChange());
  watcher.onDidCreate(() => void onChange());
  return watcher;
}

function normalizeEol(text: string, eol: vscode.EndOfLine): string {
  const newline = eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  return text.replace(/\r\n|\r|\n/g, newline);
}

function detectEndOfLine(text: string): vscode.EndOfLine {
  return text.includes('\r\n') ? vscode.EndOfLine.CRLF : vscode.EndOfLine.LF;
}

async function writeClipboard(text: string): Promise<void> {
  await vscode.env.clipboard.writeText(text);
  vscode.window.setStatusBarMessage('Copied as HTML', 2000);
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}
