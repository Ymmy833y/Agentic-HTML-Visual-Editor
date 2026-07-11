import * as vscode from 'vscode';
import { CUSTOM_EDITOR_VIEW_TYPE } from '../commands/openInVisualEditor';
import { AhveDocument } from './AhveDocument';
import { computeInitPayload, type UnsavedBackup } from './backup';
import { readBackupFile, writeBackupFile } from './backupFile';
import { mergeHtml } from './merge';
import type {
  CopyFormat,
  ExtensionToWebviewMessage,
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
    vscode.CustomDocumentContentChangeEvent<AhveDocument>
  >();

  // Content-change events only (no undo/redo integration): undo stays inside
  // the webview's contenteditable, VSCode just tracks dirty until save/revert.
  public readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

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
   * Test hook: mark the open WYSIWYG document for `uri` dirty, exactly as a
   * `dirtyChanged` message from its webview would. Integration tests cannot
   * reach into the webview DOM to produce a real edit.
   */
  public fireTestEdit(uri: vscode.Uri): boolean {
    // Fall back to fsPath matching: VSCode may normalize the uri (e.g. drive
    // letter casing on Windows) before it reaches openCustomDocument.
    const document =
      this.documents.get(uri.toString()) ??
      [...this.documents.values()].find((d) => d.uri.fsPath === uri.fsPath);
    if (!document) return false;
    this._onDidChangeCustomDocument.fire({ document });
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

  public async resolveCustomEditor(
    document: AhveDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    document.panel = webviewPanel;

    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')],
    };

    const fileName = document.uri.path.split('/').at(-1) ?? '';
    webviewPanel.title = `${fileName} (WYSIWYG)`;
    webviewPanel.iconPath = {
      light: vscode.Uri.joinPath(this.context.extensionUri, 'icons', 'ahve-light.svg'),
      dark: vscode.Uri.joinPath(this.context.extensionUri, 'icons', 'ahve-dark.svg'),
    };
    webviewPanel.webview.html = this.getHtml(webviewPanel.webview);

    AhveEditorProvider.activePanel = webviewPanel;

    const post = (message: ExtensionToWebviewMessage): void => {
      void webviewPanel.webview.postMessage(message);
    };

    // Pin the text buffer open. Unlike a custom TEXT editor, a custom editor
    // does not keep the TextDocument alive, and onDidChangeTextDocument only
    // fires for open documents — without the pin, external file changes would
    // stop reaching the view once the text tab is closed.
    try {
      await vscode.workspace.openTextDocument(document.uri);
    } catch {
      // Missing on disk; the save path recreates it from the view content.
    }
    const repinSubscription = vscode.workspace.onDidCloseTextDocument((doc) => {
      if (doc.uri.toString() !== document.uri.toString()) return;
      // Re-pin after VSCode garbage-collects the unreferenced buffer. Fails
      // when the file disappeared from disk — handled at save time.
      vscode.workspace.openTextDocument(document.uri).then(undefined, () => undefined);
    });

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
            let docText: string;
            try {
              docText = (await vscode.workspace.openTextDocument(document.uri)).getText();
            } catch {
              docText = backup?.baseHtml ?? '';
            }
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
          case 'dirtyChanged':
            this._onDidChangeCustomDocument.fire({ document });
            break;
          case 'requestSave': {
            await vscode.workspace.save(document.uri);
            // With both a text tab and a WYSIWYG tab open for the resource,
            // workspace.save targets "the editor identified by the resource"
            // without specifying which. If the WYSIWYG tab is still dirty,
            // save the active editor (this panel — the request came from its
            // webview) explicitly.
            if (isWysiwygTabDirty(document.uri)) {
              await vscode.commands.executeCommand('workbench.action.files.save');
            }
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
      viewStateSubscription.dispose();
      repinSubscription.dispose();
    });
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

    let textDoc: vscode.TextDocument;
    try {
      textDoc = await vscode.workspace.openTextDocument(document.uri);
    } catch {
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
      await textDoc.save();
      post({ type: 'saveResult', html: textDoc.getText(), ok: true });
      return;
    }

    // Apply the WYSIWYG changes as a diff against the base the view last
    // synced from, so edits made directly to the document in the meantime
    // are preserved (conflicting regions keep both versions).
    const merged = mergeHtml(view.baseHtml, view.html, textDoc.getText());
    let applied = false;
    document.suppressEcho = true;
    try {
      applied = await applyEdit(textDoc, merged);
    } finally {
      document.suppressEcho = false;
    }
    if (!applied) {
      // Saving anyway would write the document WITHOUT the view's changes
      // and the view would sync to it, silently dropping them. Keep the view
      // dirty instead — rejecting is what keeps the tab's dirty indicator,
      // resolving would clear it with the changes still unsaved.
      vscode.window.showErrorMessage(
        'Could not apply the WYSIWYG changes to the document; the file was not saved.',
      );
      post({ type: 'saveResult', html: textDoc.getText(), ok: false });
      throw new Error('Could not apply the WYSIWYG changes to the document.');
    }

    const saved = await textDoc.save();
    if (!saved && textDoc.isDirty) {
      // A no-op save of a clean buffer resolves false too — only a buffer
      // still dirty after save() signals an actual failure.
      post({ type: 'saveResult', html: textDoc.getText(), ok: false });
      throw new Error('Saving the document failed.');
    }
    // The unsaved changes are now in the file; drop their backup source.
    document.lastKnown = undefined;
    // Echo the authoritative post-save text (save hooks such as formatting or
    // final-newline insertion may have adjusted it) so the webview can update
    // its sync base.
    post({ type: 'saveResult', html: textDoc.getText(), ok: true });
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
      let buffer: string | undefined;
      try {
        buffer = (await vscode.workspace.openTextDocument(document.uri)).getText();
      } catch {
        buffer = undefined;
      }
      content = buffer === undefined ? view.html : mergeHtml(view.baseHtml, view.html, buffer);
    } else {
      try {
        content = (await vscode.workspace.openTextDocument(document.uri)).getText();
      } catch {
        content = '';
      }
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
    const textDoc = await vscode.workspace.openTextDocument(document.uri);
    document.pendingRestore = undefined;
    document.lastKnown = undefined;
    void document.panel?.webview.postMessage({
      type: 'revert',
      html: textDoc.getText(),
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

  private getHtml(webview: vscode.Webview): string {
    const nonce = makeNonce();
    const cspSource = webview.cspSource;
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js'),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.css'),
    );

    // CSP defaults to 'none' for every directive and we opt back in only for
    // the bundle's own script, the stylesheet, and rendered <img>/font assets.
    // `connect-src`, `frame-src`, and `form-action` are listed explicitly even
    // though `default-src 'none'` already blocks them, so the policy is easy
    // to audit at a glance.
    const csp = [
      `default-src 'none'`,
      `style-src ${cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${cspSource} https: data:`,
      `font-src ${cspSource}`,
      `connect-src 'none'`,
      `frame-src 'none'`,
      `form-action 'none'`,
    ].join('; ');

    return /* html */ `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
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

/** Whether the WYSIWYG tab for `uri` currently shows the dirty indicator. */
function isWysiwygTabDirty(uri: vscode.Uri): boolean {
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (
        tab.input instanceof vscode.TabInputCustom &&
        tab.input.viewType === AhveEditorProvider.viewType &&
        tab.input.uri.toString() === uri.toString()
      ) {
        return tab.isDirty;
      }
    }
  }
  return false;
}

async function applyEdit(document: vscode.TextDocument, newText: string): Promise<boolean> {
  if (newText === document.getText()) return true;
  const edit = new vscode.WorkspaceEdit();
  const fullRange = new vscode.Range(
    document.positionAt(0),
    document.positionAt(document.getText().length),
  );
  edit.replace(document.uri, fullRange, newText);
  return vscode.workspace.applyEdit(edit);
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
