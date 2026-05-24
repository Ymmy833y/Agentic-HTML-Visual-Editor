import * as vscode from 'vscode';
import { CUSTOM_EDITOR_VIEW_TYPE } from '../commands/openInWysiwyg';
import type {
  CopyFormat,
  ExtensionToWebviewMessage,
  WebviewToExtensionMessage,
} from '../shared/messages';

export class HtmlWysiwygEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = CUSTOM_EDITOR_VIEW_TYPE;

  // Tracks the most recently active WYSIWYG panel so command-palette commands
  // (e.g. Copy as HTML) can target it.
  private static activePanel: vscode.WebviewPanel | null = null;

  public static getActivePanel(): vscode.WebviewPanel | null {
    return HtmlWysiwygEditorProvider.activePanel;
  }

  constructor(private readonly context: vscode.ExtensionContext) {}

  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new HtmlWysiwygEditorProvider(context);
    return vscode.window.registerCustomEditorProvider(HtmlWysiwygEditorProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    });
  }

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')],
    };

    webviewPanel.webview.html = this.getHtml(webviewPanel.webview);

    HtmlWysiwygEditorProvider.activePanel = webviewPanel;

    const post = (message: ExtensionToWebviewMessage): void => {
      webviewPanel.webview.postMessage(message);
    };

    let suppressEcho = false;

    const messageSubscription = webviewPanel.webview.onDidReceiveMessage(
      async (message: WebviewToExtensionMessage) => {
        switch (message.type) {
          case 'ready':
            post({ type: 'init', html: document.getText() });
            break;
          case 'edit':
            suppressEcho = true;
            try {
              await applyEdit(document, message.html);
            } finally {
              suppressEcho = false;
            }
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
        HtmlWysiwygEditorProvider.activePanel = webviewPanel;
      } else if (HtmlWysiwygEditorProvider.activePanel === webviewPanel) {
        HtmlWysiwygEditorProvider.activePanel = null;
      }
    });

    webviewPanel.onDidDispose(() => {
      if (HtmlWysiwygEditorProvider.activePanel === webviewPanel) {
        HtmlWysiwygEditorProvider.activePanel = null;
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
    <link rel="stylesheet" href="${styleUri}" />
    <title>HTML WYSIWYG</title>
  </head>
  <body>
    <div id="hw-root" role="document"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }
}

async function applyEdit(document: vscode.TextDocument, newText: string): Promise<void> {
  if (newText === document.getText()) return;
  const edit = new vscode.WorkspaceEdit();
  const fullRange = new vscode.Range(
    document.positionAt(0),
    document.positionAt(document.getText().length),
  );
  edit.replace(document.uri, fullRange, newText);
  await vscode.workspace.applyEdit(edit);
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
