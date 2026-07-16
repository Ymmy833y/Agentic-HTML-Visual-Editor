import * as vscode from 'vscode';
import { CUSTOM_EDITOR_VIEW_TYPE } from '../commands/openInVisualEditor';
import { AhveDocument } from './AhveDocument';
import { computeInitPayload, type UnsavedBackup } from './backup';
import { readBackupFile, writeBackupFile } from './backupFile';
import { buildContentSecurityPolicy } from './csp';
import { mergeHtml } from './merge';
import { mergeHistoryTransition } from './history';
import { openRelativeFileLink } from './relativeFileLinks';
import type {
  CopyFormat,
  ExtensionToWebviewMessage,
  SerializedEditState,
  WebviewToExtensionMessage,
} from '../shared/messages';

// workspaceState key that held the latest unsaved view content per document
// before backups moved to VSCode's native custom-editor backup mechanism.
// Still read (once) so unsaved content from a previous extension version is
// not lost on update.
const LEGACY_BACKUP_KEY_PREFIX = 'ahve.unsavedBackup:';

function legacyBackupKey(uri: vscode.Uri): string {
  return LEGACY_BACKUP_KEY_PREFIX + uri.toString();
}

// The WYSIWYG editor is a full CustomEditorProvider (not a
// CustomTextEditorProvider) so its tab's dirty indicator is independent of
// the text buffer: WYSIWYG edits stay in the webview until save, and the
// tab's ● is driven by onDidChangeCustomDocument instead of TextDocument
// dirty state. The TextDocument remains the sync target — saves three-way
// merge the view into the buffer and save it — so the text editor and the
// WYSIWYG view keep seeing each other's changes.
export class AhveEditorProvider implements vscode.CustomEditorProvider<AhveDocument> {
  public static readonly viewType = CUSTOM_EDITOR_VIEW_TYPE;

  // Tracks the most recently active WYSIWYG panel so command-palette commands
  // (e.g. Copy as HTML) can target it.
  private static activePanel: vscode.WebviewPanel | null = null;

  public static getActivePanel(): vscode.WebviewPanel | null {
    return AhveEditorProvider.activePanel;
  }

  // Open documents by uri, for save fan-out and the test hook.
  private readonly documents = new Map<string, AhveDocument>();

  private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<
    vscode.CustomDocumentEditEvent<AhveDocument>
  >();

  // Every WYSIWYG transaction is a native custom-editor edit. VS Code owns
  // stack traversal and the saved-state marker; the callbacks remount the
  // corresponding visual state in the webview.
  public readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  public registerHistoryCommands(): void {
    this.context.subscriptions.push(
      vscode.commands.registerCommand('ahve.save', () => this.runSaveCommand()),
      vscode.commands.registerCommand('ahve.undo', () => this.runHistoryCommand('undo')),
      vscode.commands.registerCommand('ahve.redo', () => this.runHistoryCommand('redo')),
    );
  }

  private async runSaveCommand(document?: AhveDocument): Promise<void> {
    const target = document ?? this.getActiveDocument();
    if (!target) return;
    await target.flushHistory();
    await vscode.commands.executeCommand('workbench.action.files.save');
  }

  private getActiveDocument(): AhveDocument | undefined {
    const panel = AhveEditorProvider.activePanel;
    return panel
      ? [...this.documents.values()].find((candidate) => candidate.panel === panel)
      : undefined;
  }

  private async runHistoryCommand(command: 'undo' | 'redo'): Promise<void> {
    const document = this.getActiveDocument();
    if (!document) return;
    await document.flushHistory();
    await vscode.commands.executeCommand(command);
  }

  public static register(context: vscode.ExtensionContext): {
    registration: vscode.Disposable;
    provider: AhveEditorProvider;
  } {
    const provider = new AhveEditorProvider(context);
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
   * Test hook: add a reversible no-op WYSIWYG transaction. Integration tests
   * cannot reach into the webview DOM to produce a real edit.
   */
  public fireTestEdit(uri: vscode.Uri): boolean {
    // Fall back to fsPath matching: VSCode may normalize the uri (e.g. drive
    // letter casing on Windows) before it reaches openCustomDocument.
    const document =
      this.documents.get(uri.toString()) ??
      [...this.documents.values()].find((d) => d.uri.fsPath === uri.fsPath);
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
    const document = this.findDocument(uri);
    if (!document?.panel) return false;
    void document.panel.webview.postMessage({ type: 'testSetHtml', html });
    return true;
  }

  public async getTestViewHtml(uri: vscode.Uri): Promise<string | null> {
    const document = this.findDocument(uri);
    if (!document) return null;
    return (await document.requestFileData()).html;
  }

  public requestTestViewSave(uri: vscode.Uri): boolean {
    const document = this.findDocument(uri);
    if (!document?.panel) return false;
    void document.panel.webview.postMessage({ type: 'testRequestSave' });
    return true;
  }

  public openTestRelativeFile(uri: vscode.Uri, href: string): Promise<boolean> {
    return openRelativeFileLink(uri, href);
  }

  /**
   * Test hook: drive the webview to post an `openRelativeFile` message so the
   * host's message handler (not just `openRelativeFileLink`) is exercised end
   * to end with the real document uri.
   */
  public openTestRelativeFileViaWebview(uri: vscode.Uri, href: string): boolean {
    const document = this.findDocument(uri);
    if (!document?.panel) return false;
    void document.panel.webview.postMessage({ type: 'testOpenRelativeFile', href });
    return true;
  }

  private findDocument(uri: vscode.Uri): AhveDocument | undefined {
    return (
      this.documents.get(uri.toString()) ??
      [...this.documents.values()].find((document) => document.uri.fsPath === uri.fsPath)
    );
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
      // One-time migration of a backup persisted by a previous extension
      // version (workspaceState based).
      const key = legacyBackupKey(uri);
      const legacy = this.context.workspaceState.get<UnsavedBackup>(key);
      if (legacy) {
        restore = legacy;
        await this.context.workspaceState.update(key, undefined);
      }
    }
    const document = new AhveDocument(uri, restore, () => {
      if (this.documents.get(uri.toString()) === document) {
        this.documents.delete(uri.toString());
      }
    });
    this.documents.set(uri.toString(), document);
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

    AhveEditorProvider.activePanel = webviewPanel;

    const post = (message: ExtensionToWebviewMessage): void => {
      void webviewPanel.webview.postMessage(message);
    };

    const messageSubscription = webviewPanel.webview.onDidReceiveMessage(
      async (message: WebviewToExtensionMessage) => {
        switch (message.type) {
          case 'ready': {
            // Restore unsaved changes from a hot-exit backup (consumed here)
            // or from the freshest content a previous webview streamed (the
            // webview is recreated when the panel is moved or reloaded). If
            // the document changed in the meantime, the restored content is
            // its three-way merge with those changes.
            const backup = document.pendingRestore ?? document.lastKnown;
            document.pendingRestore = undefined;
            const docText =
              (await readOpenDocumentOrFile(document.uri)) ?? backup?.baseHtml ?? '';
            const payload = computeInitPayload(docText, backup);
            if (payload.restored !== undefined) {
              // A restored view is dirty before any edit streams new content;
              // seed the backup source so hot exit has something to persist.
              document.lastKnown = { baseHtml: docText, html: payload.restored };
            } else {
              // Stale or already-saved backup: consume it.
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
            // The request came from the active WYSIWYG webview. Saving by URI
            // is ambiguous when an HTML text tab for the same resource is also
            // open: VS Code can save that stale TextDocument first and prevent
            // it from reloading the subsequent custom-editor write. Save the
            // active editor exactly once instead.
            await this.runSaveCommand(document);
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
            await writeClipboard(message.text, message.format);
            break;
        }
      },
    );

    const documentChangeSubscription = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== document.uri.toString()) return;
      if (document.suppressEcho) return;
      post({ type: 'documentChanged', html: e.document.getText() });
    });

    // Watch disk changes without pinning a TextDocument. Keeping an invisible
    // text model open makes filesystem saves create/replace undo elements for
    // the same URI as the custom editor, which collapses visual undo after a
    // save. A real text tab is still covered by onDidChangeTextDocument above.
    const fileWatcher = createDocumentWatcher(document.uri, async () => {
      if (document.suppressEcho) return;
      const html = await readFileText(document.uri);
      if (html !== undefined) post({ type: 'documentChanged', html });
    });

    const viewStateSubscription = webviewPanel.onDidChangeViewState(() => {
      if (webviewPanel.active) {
        AhveEditorProvider.activePanel = webviewPanel;
      } else if (AhveEditorProvider.activePanel === webviewPanel) {
        AhveEditorProvider.activePanel = null;
      }
    });

    webviewPanel.onDidDispose(() => {
      if (AhveEditorProvider.activePanel === webviewPanel) {
        AhveEditorProvider.activePanel = null;
      }
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
    // Serialize saves per document: the merge input (buffer text) must not go
    // stale under an overlapping save. Keep the chain alive after a failed
    // save so later saves still run.
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
      // Webview unreachable (still booting, blocked, or torn down): fall back
      // to the freshest content it streamed.
      const fallback = document.lastKnown;
      if (fallback) view = { html: fallback.html, baseHtml: fallback.baseHtml };
    }

    const textDoc = findOpenTextDocument(document.uri);
    let documentText = textDoc?.getText() ?? (await readFileText(document.uri));
    if (documentText === undefined) {
      // The file disappeared from disk and no buffer survives: recreate it
      // from the view content rather than losing the edits.
      if (view.html !== null) {
        await vscode.workspace.fs.writeFile(document.uri, new TextEncoder().encode(view.html));
        document.lastKnown = undefined;
        post({ type: 'saveResult', html: view.html, ok: true });
      }
      return;
    }

    if (view.html === null || view.baseHtml === null) {
      // No WYSIWYG content to merge; behave as a plain save of the buffer.
      // Still echo a saveResult so a slow view that answered the snapshot
      // request after our timeout settles its in-flight bookkeeping.
      if (textDoc) await textDoc.save();
      post({ type: 'saveResult', html: textDoc?.getText() ?? documentText, ok: true });
      return;
    }

    // Commit unsaved text-tab edits first. They are then included in the
    // three-way merge below. Saving them before the merge also lets normal
    // text save participants run without turning the WYSIWYG result itself
    // into a TextDocument undo element.
    if (textDoc?.isDirty) {
      const textSaved = await textDoc.save();
      if (!textSaved && textDoc.isDirty) {
        post({ type: 'saveResult', html: textDoc.getText(), ok: false });
        throw new Error('Saving the HTML text document failed.');
      }
      documentText = textDoc.getText();
    }

    // Persist the WYSIWYG merge directly through the filesystem. Applying a
    // WorkspaceEdit here would add a full-document replacement to the same
    // URI undo stack used by CustomDocumentEditEvent. After save, the first
    // undo would consume that replacement instead of the last visual edit.
    const merged = normalizeEol(
      mergeHtml(view.baseHtml, view.html, documentText),
      textDoc?.eol ?? detectEndOfLine(documentText),
    );
    document.suppressEcho = true;
    try {
      // The filesystem write is the persistence boundary. VS Code may reload
      // an inactive, clean HTML tab later; that UI refresh must not turn a
      // successful disk write into a WYSIWYG save failure.
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
    // The unsaved changes are now in the file; drop their backup source.
    document.lastKnown = undefined;
    // Echo the authoritative post-save text (save hooks such as formatting or
    // final-newline insertion may have adjusted it) so the webview can update
    // its sync base.
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
    // The original buffer is left untouched; VSCode reopens the editor on the
    // destination resource (a fresh openCustomDocument).
    await vscode.workspace.fs.writeFile(destination, new TextEncoder().encode(content));
  }

  public async revertCustomDocument(
    document: AhveDocument,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    // Revert to the text BUFFER, not the disk file: the merge invariant is
    // "baseHtml === buffer content at last sync", and unsaved text-tab edits
    // must survive a WYSIWYG revert (they are not this editor's changes).
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
    // `lastKnown` is fed by the webview's debounced backup stream (flushed on
    // unload) and seeded on restore, so it is fresh whenever the document is
    // dirty. Throwing keeps VSCode's previous backup for this document.
    const data = document.lastKnown;
    if (!data) {
      throw new Error('No unsaved WYSIWYG content to back up.');
    }
    await writeBackupFile(context.destination, data);
    return {
      id: context.destination.toString(),
      delete: (): void => {
        // Best-effort: the backup file may already be gone.
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

    // Resolve relative resource paths (e.g. `<img src="./images/foo.png">`) in
    // the rendered content against the document's own directory. The webview
    // runs at a `vscode-webview://` origin, so without a <base> every relative
    // URL resolves against that origin and local images never load. Only file
    // documents have a meaningful on-disk directory; other schemes (untitled,
    // etc.) get no <base> and keep the previous behaviour. The browser uses the
    // base only to resolve URLs at fetch time — the literal `src` attribute
    // string is untouched, so serialization/round-trip is unaffected.
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

// Resource roots the webview may load local files (images, fonts) from. Always
// includes the extension's `dist` bundle. For file documents we also allow the
// document's own directory (so `./…` image paths load) and the enclosing
// workspace folder (so `../…` paths that stay inside the workspace load too).
// Absolute/out-of-workspace paths are intentionally left unreachable.
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

async function writeClipboard(text: string, format: CopyFormat): Promise<void> {
  await vscode.env.clipboard.writeText(text);
  vscode.window.setStatusBarMessage(
    format === 'confluence'
      ? 'Copied as Confluence-compatible HTML'
      : 'Copied as HTML',
    2000,
  );
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}
