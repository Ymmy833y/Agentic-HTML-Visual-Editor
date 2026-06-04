# ソースコードの解体新書 — ファイル一覧と機能早見表

機能番号の定義は [基本設計書 00-overview.md](../design/00-overview.md) を参照してください。

## ファイル一覧

### Extension 層（src/）

| ファイル | 主な役割 | 担当機能# |
|---|---|---|
| `src/extension.ts` | 拡張機能のエントリポイント。コマンドとカスタムエディタを登録する | #1 |
| `src/editor/HtmlWysiwygEditorProvider.ts` | CustomTextEditorProvider の実装。Webview の初期化・メッセージ仲介・ファイル書き込み | #1, #7, #10 |
| `src/commands/openInWysiwyg.ts` | 「WYSIWYG で開く」コマンドの実装 | #1 |
| `src/commands/copy.ts` | HTMLコピー・Confluenceコピーコマンドの実装 | #7 |
| `src/shared/messages.ts` | Extension ↔ Webview 間のメッセージ型定義 | #1, #7, #10 |

### Webview コア層（webview/core/）

| ファイル | 主な役割 | 担当機能# |
|---|---|---|
| `webview/core/editor-core.ts` | contenteditable の有効化、入力イベントのインターセプト、デバウンス、Markdownショートカット | #1, #9 |
| `webview/core/renderer.ts` | HTML のパース・サニタイズ・body 分割 | #1, #8 |
| `webview/core/serialize.ts` | contenteditable DOM を保存用 HTML に変換する | #10 |
| `webview/core/selection.ts` | DOM 再マウント後のカーソル位置復元（有意インデックスパス方式） | #10 |
| `webview/core/placeholder.ts` | 空ブロックに `<br>` プレースホルダーを挿入して選択可能にする | #1 |

### コマンド層（webview/commands/）

| ファイル | 主な役割 | 担当機能# |
|---|---|---|
| `webview/commands/inline-format.ts` | インライン書式のトグル・クリア・カバレッジ判定 | #2 |
| `webview/commands/block-format.ts` | ブロックタグの変換・水平線の挿入 | #3 |
| `webview/commands/link.ts` | リンクの挿入・更新・削除 | #4 |
| `webview/commands/query.ts` | ツールバーの状態反映のための読み取り専用クエリ | #2, #3, #4 |

### 機能層（webview/features/）

| ファイル | 主な役割 | 担当機能# |
|---|---|---|
| `webview/features/clipboard/copy.ts` | コピー用 HTML の生成・インラインラッパー拡張 | #7 |
| `webview/features/clipboard/confluence.ts` | Confluence 互換 HTML への変換 | #7 |
| `webview/features/clipboard/paste-sanitize.ts` | ペースト時のノイズ削減・スタイルプルーニング | #8 |
| `webview/features/comment/comment-dom.ts` | コメント要素の DOM 読み書きヘルパー | #6 |
| `webview/features/comment/comment-commands.ts` | コメントの追加・削除コマンド | #6 |
| `webview/features/comment/comment-popup.ts` | コメントポップアップ UI | #6 |
| `webview/features/table/table-model.ts` | colspan/rowspan 解決済みの論理グリッドモデル構築 | #5 |
| `webview/features/table/structure-commands.ts` | テーブル挿入・行列操作・ヘッダー変換・削除・Tabナビゲーション | #5 |
| `webview/features/table/merge-commands.ts` | セルの結合・分割 | #5 |
| `webview/features/table/cell-utils.ts` | セル作成・rowspan/colspan 設定・挿入位置計算ユーティリティ | #5 |
| `webview/features/table/width-commands.ts` | 列幅の管理・px/%切替・均等配置 | #5 |
| `webview/features/table/table-menu.ts` | テーブル右クリックコンテキストメニュー | #5 |
| `webview/features/table/table-picker.ts` | テーブル挿入グリッドピッカー UI | #5 |
| `webview/features/table/table-resize.ts` | 列幅のドラッグリサイズ | #5 |

### UI 層（webview/ui/）

| ファイル | 主な役割 | 担当機能# |
|---|---|---|
| `webview/ui/toolbar.ts` | スティッキーツールバー（ボタン生成・アクティブ状態・ドロップダウン） | #2, #3, #4, #5, #6, #7 |
| `webview/ui/floating-menu.ts` | 選択時表示のフローティングメニュー | #2, #4, #6 |
| `webview/ui/link-dialog.ts` | リンク挿入ダイアログ（モーダル） | #4 |
| `webview/ui/tooltip.ts` | ツールチップユーティリティ | 全UI |

### 共有ユーティリティ（webview/shared/）

| ファイル | 主な役割 | 担当機能# |
|---|---|---|
| `webview/shared/constants.ts` | `BLOCK_TAGS`, `INLINE_FORMAT_TAGS` 定数 | #2, #3, #9 |
| `webview/shared/command-context.ts` | `CommandContext` 型定義（`{ root: HTMLElement }`） | 全コマンド |
| `webview/shared/dom-utils.ts` | DOM 走査・操作の共通ユーティリティ | 全コマンド |

### エントリポイント

| ファイル | 主な役割 | 担当機能# |
|---|---|---|
| `webview/main.ts` | Webview エントリポイント。すべての機能を統合し、メッセージループとイベントを管理する | 全機能 |

---

## BLOCK_TAGS の定義が複数存在する理由

プロジェクト内に `BLOCK_TAGS` に相当する集合が3箇所存在するが、これは意図的な分離：

| ファイル | 内容 | 目的 |
|---|---|---|
| `webview/shared/constants.ts` | 大文字: `P, H1-H6, BLOCKQUOTE, PRE, DIV, LI` | コマンド層でのブロック祖先探索（`UL/OL/TABLE` は含まない） |
| `webview/core/serialize.ts` | 大文字: 上記 + `UL, OL, HR, FIGURE, FIGCAPTION, TABLE` | シリアライズ時のブロック要素判定（リストやテーブルを含む） |
| `webview/features/clipboard/paste-sanitize.ts` | 小文字: `p, h1-h6, blockquote, pre, div, li, td, th` | ペースト時のスタイル許可判定（セル要素を含む） |

詳細なマッピング表は [src-layer.md](./src-layer.md) と [webview-layer.md](./webview-layer.md) を参照してください。
