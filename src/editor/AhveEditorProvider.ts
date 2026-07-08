import * as vscode from 'vscode';
import { CUSTOM_EDITOR_VIEW_TYPE } from '../commands/openInVisualEditor';
import { computeInitPayload, type UnsavedBackup } from './backup';
import { mergeHtml } from './merge';
import type {
  CopyFormat,
  ExtensionToWebviewMessage,
  WebviewToExtensionMessage,
} from '../shared/messages';

// workspaceState key holding the latest unsaved view content per document.
const BACKUP_KEY_PREFIX = 'ahve.unsavedBackup:';

function backupKey(uri: vscode.Uri): string {
  return BACKUP_KEY_PREFIX + uri.toString();
}

export class AhveEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = CUSTOM_EDITOR_VIEW_TYPE;

  // Tracks the most recently active WYSIWYG panel so command-palette commands
  // (e.g. Copy as HTML) can target it.
  private static activePanel: vscode.WebviewPanel | null = null;

  public static getActivePanel(): vscode.WebviewPanel | null {
    return AhveEditorProvider.activePanel;
  }

  constructor(private readonly context: vscode.ExtensionContext) {}

  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new AhveEditorProvider(context);
    return vscode.window.registerCustomEditorProvider(AhveEditorProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    });
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
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
      webviewPanel.webview.postMessage(message);
    };

    let suppressEcho = false;

    // Saves are serialized through a promise chain: the message handler can
    // interleave at its awaits, and two overlapping saves would otherwise both
    // read a stale document.getText() as their merge input.
    let saveChain: Promise<void> = Promise.resolve();

    const handleSave = async (html: string, baseHtml: string): Promise<void> => {
      // Apply the WYSIWYG changes as a diff against the base the view last
      // synced from, so edits made directly to the document in the meantime
      // are preserved (conflicting regions keep both versions).
      const merged = mergeHtml(baseHtml, html, document.getText());
      let applied = false;
      suppressEcho = true;
      try {
        applied = await applyEdit(document, merged);
      } finally {
        suppressEcho = false;
      }
      if (!applied) {
        // Saving anyway would write the document WITHOUT the view's changes
        // and the view would sync to it, silently dropping them. Keep the
        // view dirty (and its host-side backup) instead.
        vscode.window.showErrorMessage(
          'Could not apply the WYSIWYG changes to the document; the file was not saved.',
        );
        post({ type: 'saveResult', html: document.getText(), ok: false });
        return;
      }
      try {
        await document.save();
        // The unsaved changes are now in the file; drop their backup.
        await this.context.workspaceState.update(backupKey(document.uri), undefined);
      } finally {
        // Echo the authoritative post-save text (save hooks such as
        // formatting or final-newline insertion may have adjusted it) so the
        // webview can update its sync base.
        post({ type: 'saveResult', html: document.getText(), ok: true });
      }
    };

    const messageSubscription = webviewPanel.webview.onDidReceiveMessage(
      async (message: WebviewToExtensionMessage) => {
        switch (message.type) {
          case 'ready': {
            // Restore unsaved changes a previous view session backed up (the
            // webview is disposed whenever the tab is switched over to the
            // text editor). If the document changed in the meantime, the
            // restored content is its three-way merge with those changes.
            const key = backupKey(document.uri);
            const backup = this.context.workspaceState.get<UnsavedBackup>(key);
            const payload = computeInitPayload(document.getText(), backup);
            if (backup && payload.restored === undefined) {
              // Stale or already-saved backup: consume it.
              await this.context.workspaceState.update(key, undefined);
            }
            post({ type: 'init', html: payload.html, restored: payload.restored });
            break;
          }
          case 'save': {
            const { html, baseHtml } = message;
            const run = saveChain.then(() => handleSave(html, baseHtml));
            // Keep the chain alive after a failed save so later saves still run.
            saveChain = run.catch(() => undefined);
            await run;
            break;
          }
          case 'backup':
            await this.context.workspaceState.update(backupKey(document.uri), {
              baseHtml: message.baseHtml,
              html: message.html,
            } satisfies UnsavedBackup);
            break;
          case 'clipboardWrite':
            await writeClipboard(message.text, message.format);
            break;
        }
      },
    );

    const documentChangeSubscription = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== document.uri.toString()) return;
      if (suppressEcho) return;
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
      messageSubscription.dispose();
      documentChangeSubscription.dispose();
      viewStateSubscription.dispose();
    });
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
