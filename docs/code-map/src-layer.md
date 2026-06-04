# ソースコードの解体新書 — Extension 層（src/）

機能番号の定義は [基本設計書 00-overview.md](../design/00-overview.md) を参照してください。

---

## src/extension.ts

**役割**: 拡張機能のアクティベーション。コマンドとカスタムエディタプロバイダをVS Codeに登録する。

| 関数 | 機能# | 要件 |
|---|---|---|
| `activate(context)` | #1 | 拡張機能起動時にコマンドとカスタムエディタを登録する |
| `deactivate()` | #1 | Dispose はサブスクリプション管理に委譲するため本体は空 |

---

## src/commands/openInWysiwyg.ts

**役割**: コマンドパレットやメニューから WYSIWYG エディタを開くコマンドの登録・実行。

| 関数/定数 | 機能# | 要件 |
|---|---|---|
| `OPEN_IN_WYSIWYG_COMMAND` | #1 | コマンド ID `'htmlWysiwyg.openInWysiwyg'` の定義 |
| `CUSTOM_EDITOR_VIEW_TYPE` | #1 | カスタムエディタの View Type ID `'htmlWysiwyg.editor'` の定義 |
| `registerOpenInWysiwygCommand(context)` | #1 | コマンドを登録する。URI 未指定時はアクティブエディタのファイルを使用し、`vscode.openWith` でカスタムエディタとして開く |

---

## src/commands/copy.ts

**役割**: HTML コピーと Confluence 互換 HTML コピーのコマンド登録と実行。

| 関数/定数 | 機能# | 要件 |
|---|---|---|
| `COPY_AS_HTML_COMMAND` | #7 | コマンド ID `'htmlWysiwyg.copyAsHtml'` の定義 |
| `COPY_AS_CONFLUENCE_HTML_COMMAND` | #7 | コマンド ID `'htmlWysiwyg.copyAsConfluenceHtml'` の定義 |
| `registerCopyCommands(context)` | #7 | 2つのコピーコマンドを登録する |
| `requestCopy(format)` | #7 | アクティブパネルを取得して `{ type: 'copyToClipboard', format }` を Webview に送信する。パネルがなければ警告を表示する |

---

## src/editor/HtmlWysiwygEditorProvider.ts

**役割**: VS Code の CustomTextEditorProvider インターフェースの実装。ファイルと Webview 間の双方向同期を担当する。

| 関数/メソッド | 機能# | 要件 |
|---|---|---|
| `HtmlWysiwygEditorProvider.register(context)` | #1 | `registerCustomEditorProvider()` でプロバイダを登録する。`retainContextWhenHidden: true`、`supportsMultipleEditorsPerDocument: false` で設定する |
| `getActivePanel()` | #7 | コピーコマンドが対象パネルを取得するための静的アクセサ |
| `resolveCustomTextEditor(doc, panel, token)` | #1, #10 | Webview を初期化し、メッセージリスナーと変更監視を設定する |
| `getHtml(webview)` | #1 | nonce ベースの CSP を持つ Webview シェル HTML を生成する（`#hw-root` + スクリプト/スタイル参照） |
| `applyEdit(doc, newText)` | #10 | `WorkspaceEdit` でドキュメント全体を `newText` に置換する。内容が変わっていない場合は何もしない |
| `writeClipboard(text, format)` | #7 | `vscode.env.clipboard.writeText()` でテキストを書き込み、ステータスバーにメッセージを 2000ms 表示する |
| `makeNonce()` | #1 | 32文字のランダム英数字文字列（CSP nonce 用）を生成する |

**重要な変数/フィールド:**

| 変数 | 機能# | 要件 |
|---|---|---|
| `activePanel` (static) | #7 | 最後にアクティブになった WYSIWYG パネルへの参照。コピーコマンドが対象パネルを特定するために使用する |
| `suppressEcho` (local) | #10 | `applyEdit()` 実行中に `true` にして `documentChanged` メッセージの送信を抑制する（エコーループ防止） |

---

## src/shared/messages.ts

**役割**: Extension と Webview 間のメッセージ型の定義。型安全な通信を保証する。

| 型定義 | 機能# | 要件 |
|---|---|---|
| `CopyFormat` | #7 | コピー形式の Union 型 `'html' \| 'confluence'` |
| `ExtensionToWebviewMessage` | #1, #7, #10 | Extension → Webview のメッセージ Union 型（`init`, `documentChanged`, `copyToClipboard`） |
| `WebviewToExtensionMessage` | #1, #7, #10 | Webview → Extension のメッセージ Union 型（`ready`, `edit`, `clipboardWrite`） |
