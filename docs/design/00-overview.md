# 00. アーキテクチャ概観

> 各機能の詳細は [README_ja.md](../../README_ja.md) を参照してください。このドキュメントは実装アーキテクチャと機能間の関係を記述します。

---

## 全体アーキテクチャ

HTML-WYSIWYG は VS Code の **CustomTextEditorProvider** として動作する。エディタは2つの独立した実行コンテキストに分かれており、メッセージパッシングで連携する。

```
┌──────────────────────────────────────────────────┐
│  VS Code Extension Host (Node.js)                 │
│                                                   │
│  src/extension.ts                                 │
│   ├─ registerOpenInWysiwygCommand()               │
│   ├─ registerCopyCommands()                       │
│   └─ HtmlWysiwygEditorProvider.register()         │
│                                                   │
│  HtmlWysiwygEditorProvider                        │
│   ├─ resolveCustomTextEditor() ─ Webview初期化    │
│   ├─ applyEdit()               ─ ファイル書き込み │
│   └─ writeClipboard()          ─ クリップボード   │
└──────────────────┬───────────────────────────────┘
                   │  postMessage / onDidReceiveMessage
                   │  型定義: src/shared/messages.ts
                   │
┌──────────────────▼───────────────────────────────┐
│  Webview (Browser context, IIFE bundle)           │
│                                                   │
│  webview/main.ts ── エントリポイント              │
│   ├─ core/          編集エンジン                  │
│   ├─ commands/      テキスト編集コマンド          │
│   ├─ features/      テーブル・コメント・コピー     │
│   ├─ ui/            ツールバー・メニュー           │
│   └─ shared/        定数・ユーティリティ          │
└──────────────────────────────────────────────────┘
```

---

## Extension ↔ Webview メッセージプロトコル

型定義: `src/shared/messages.ts`

### Extension → Webview

| メッセージ | タイミング | 内容 |
|---|---|---|
| `{ type: 'init'; html: string }` | Webview が `ready` を送った直後 | ファイルの現在の内容 |
| `{ type: 'documentChanged'; html: string }` | Extension 側でファイルが変更されたとき（他エディタからの変更など）| 変更後の内容 |
| `{ type: 'copyToClipboard'; format: 'html' \| 'confluence' }` | コマンドパレットのコピーコマンド実行時 | コピー形式 |

### Webview → Extension

| メッセージ | タイミング | 内容 |
|---|---|---|
| `{ type: 'ready' }` | Webview 初期化完了時 | なし |
| `{ type: 'edit'; html: string }` | ユーザーが編集した後（250ms デバウンス後） | シリアライズされた HTML |
| `{ type: 'clipboardWrite'; text: string; format: ... }` | コピー実行時 | クリップボードに書き込む文字列 |

---

## Webview 内部アーキテクチャ

### レイヤー構成

| レイヤー | ディレクトリ | 役割 |
|---|---|---|
| **コア** | `webview/core/` | contenteditable 管理・HTML パース・シリアライズ・選択範囲復元 |
| **コマンド** | `webview/commands/` | テキスト編集操作（インライン・ブロック・リンク） |
| **機能** | `webview/features/` | テーブル・コメント・クリップボードの高度な機能 |
| **UI** | `webview/ui/` | ツールバー・フローティングメニュー・ダイアログ |
| **共有** | `webview/shared/` | 定数・DOM ユーティリティ・コマンドコンテキスト型 |

### データフロー（編集操作）

```
ユーザー操作（キーボード/ツールバー）
        │
        ▼
  webview/main.ts のイベントハンドラ
        │ CommandContext = { root: HTMLElement }
        ▼
  commands/ または features/ の各コマンド関数
        │ DOM を直接書き換え
        ▼
  editor.notifyChanged()
        │ 250ms デバウンス
        ▼
  serialize() → formatForSerialize(root)
        │
        ▼
  vscode.postMessage({ type: 'edit', html })
        │
        ▼
  Extension: applyEdit() → WorkspaceEdit でファイル更新
```

### データフロー（ファイル読み込み）

```
Extension: init/documentChanged メッセージ
        │
        ▼
  mountFromSource(html)
    ├─ splitAroundBody(html) — <body>内コンテンツを抽出
    ├─ parseBodyContent(bodyInner) — サニタイズして DocumentFragment 生成
    └─ root.replaceChildren(fragment)
        │
        ▼
  comment 要素の lockChildren() — <comment-body> を contenteditable=false に
```

---

## セキュリティモデル

Webview の HTML は以下の CSP で保護されている（`HtmlWysiwygEditorProvider.getHtml()`）:

| CSP ディレクティブ | 値 |
|---|---|
| `default-src` | `'none'` |
| `script-src` | `nonce-{ランダム32文字}` のみ |
| `style-src` | VS Code webview CSP source + `'unsafe-inline'` |
| `img-src` | VS Code webview + `https:` + `data:` |
| `connect-src` | `'none'`（外部通信禁止） |
| `frame-src` | `'none'` |
| `form-action` | `'none'` |

---

## 機能番号対応表

| # | 機能 | 主なファイル |
|---|---|---|
| #1 | エディタ起動・表示 | `src/editor/`, `webview/core/renderer.ts`, `webview/core/editor-core.ts` |
| #2 | インライン書式設定 | `webview/commands/inline-format.ts` |
| #3 | ブロック書式設定 | `webview/commands/block-format.ts` |
| #4 | リンク機能 | `webview/commands/link.ts`, `webview/ui/link-dialog.ts` |
| #5 | テーブル機能 | `webview/features/table/`（9ファイル） |
| #6 | コメント機能 | `webview/features/comment/` |
| #7 | クリップボード・コピー | `webview/features/clipboard/`, `src/commands/copy.ts` |
| #8 | ペースト機能 | `webview/features/clipboard/paste-sanitize.ts` |
| #9 | マークダウンショートカット | `webview/core/editor-core.ts` |
| #10 | Extension-Webview 間同期 | `webview/core/selection.ts`, `webview/core/serialize.ts` |
