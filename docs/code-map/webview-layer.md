# ソースコードの解体新書 — Webview 層（webview/）

機能番号の定義は [基本設計書 00-overview.md](../design/00-overview.md) を参照してください。

---

## webview/main.ts

**役割**: Webview エントリポイント。全モジュールを統合し、メッセージループ・イベントハンドラ・キーボードショートカットを管理する。

| 関数/変数 | 機能# | 要件 |
|---|---|---|
| `mountFromSource(source)` | #1, #10 | HTML を解析・サニタイズして `#hw-root` にマウントする。`<comment>` 子要素をロックする |
| `serialize()` | #10 | `prefix + formatForSerialize(root) + suffix` で完全な HTML 文字列を返す |
| `handleLink()` | #4 | リンクダイアログを開き、結果を `insertLink()` に渡す。ダイアログ表示前に選択範囲を保存・復元する |
| `doCopy(format)` | #7 | `prepareCopy()` でHTML生成し `clipboardWrite` メッセージを送信する |
| `handleAddComment()` | #6 | `addComment()` を呼び、成功時にコメントポップアップを開く |
| `writeCopyPayload(e)` | #7 | `copy`/`cut` イベントのハンドラ。`text/html` と `text/plain` を ClipboardData に設定してデフォルト動作をキャンセルする |
| `insertFragmentAtCursor(fragment)` | #8 | カーソル位置に DocumentFragment を挿入し、カーソルを末尾に移動する |
| `setMergeAnchor(cell)` | #5 | テーブルセル結合の「from セル」を記憶し、視覚的マーカーを付与する |
| `keydown` イベントハンドラ | #2, #3, #4, #5, #9 | `Ctrl+B/I/K/\` とブロック変換ショートカット `Ctrl+Shift+0-6` を処理する。テーブル内 Tab ナビゲーションも処理する |
| `paste` イベントハンドラ | #8 | HTML ペーストのサニタイズ処理と `pendingPlainPaste` フラグによるプレーンテキスト強制ペースト |
| `message` イベントハンドラ | #1, #7, #10 | Extension からの `init`, `documentChanged`, `copyToClipboard` メッセージを処理する |
| `beforeunload` イベントハンドラ | #10 | `editor.flush()` で未コミットの変更を送信する |
| `prefix`, `suffix` 変数 | #10 | `<body>` タグの外側の HTML（`<html>`, `<head>` など）を保持する |
| `lastSyncedHtml` 変数 | #10 | 最後に送受信した HTML を保持して不要な再マウントと再送信を防ぐ |
| `pendingPlainPaste` 変数 | #8 | `Ctrl+Shift+V` フラグ: `keydown` でセットし `paste` イベントで消費する |

---

## webview/core/editor-core.ts

**役割**: contenteditable の有効化、ブラウザのデフォルト入力動作の上書き、Markdown ショートカット処理、デバウンスされた変更通知。

| 関数 | 機能# | 要件 |
|---|---|---|
| `setupEditor(root, onChange)` | #1, #9 | `contenteditable='true'` を設定し、`beforeinput`/`input`/`compositionstart`/`compositionend` のイベントリスナーを登録する。`EditorHandle` を返す |
| `handleEnter(root)` | #9 | ネストされたリストを持つ `<li>` での Enter を処理し、ネストリストの先頭に新しい `<li>` を挿入する |
| `handleFormattedEnter(root)` | #9 | ブロック末尾のインライン書式チェーンを再現した新しいブロックを挿入し、書式を継承させる |
| `handleHeadingShortcut(root)` | #9 | `<p>` 先頭の `#{1-6}` の後にスペースを入力したとき、見出し要素に変換する |
| `handleThematicBreakShortcut(root)` | #9 | `---` のみの `<p>` で Enter を押したとき、`<hr>` + 空 `<p>` に変換する |
| `normalizePresentationalTags(root)` | #2 | ブラウザが挿入する `<b>`/`<i>` を `<strong>`/`<em>` に書き換える。IME 入力中はスキップする |
| `scheduleChange()` | #10 | 250ms デバウンスで `onChange` コールバックをスケジュールする（内部関数） |
| `inlineChainBeforeCaret(range, block)` | #9 | カーソル直前のインライン書式タグの連鎖を外側から順に返す（書式継承 Enter 用）（内部関数） |
| `isCaretAtBlockEnd(range, block)` | #9 | カーソルがブロック末尾にあるかを判定する（内部関数） |
| `isCursorBeforeOnlyTrailingListContent(range, li)` | #9 | カーソルの後にリスト以外の実質コンテンツがないかを確認する（内部関数） |
| `EditorHandle.setEditable(enabled)` | #1 | `contentEditable` を `'true'`/`'false'` に切り替える |
| `EditorHandle.flush()` | #10 | 保留中のデバウンスタイマーをキャンセルして即座に `onChange` を実行する |
| `EditorHandle.notifyChanged()` | #2, #3, #4, #5, #6, #9 | デバウンスされた変更通知をスケジュールする（プログラム的な DOM 変更後に呼ばれる） |

---

## webview/core/renderer.ts

**役割**: HTML ファイルのパース（body 分割）とサニタイズ。

| 関数/定数 | 機能# | 要件 |
|---|---|---|
| `splitAroundBody(source)` | #1, #10 | HTML 文字列を `{ prefix, bodyInner, suffix }` に分割する。`<body>` がない場合は `null` を返す |
| `parseBodyContent(bodyInner)` | #1 | HTML 文字列を `<template>` でパースしサニタイズした DocumentFragment を返す |
| `sanitizeFragment(root)` | #1, #8 | 禁止タグの削除と属性のサニタイズを行う（ペースト処理でも共有される） |
| `FORBIDDEN_TAGS` | #1 | 削除対象タグのセット（`script`, `iframe`, `style` など） |
| `FORBIDDEN_ATTR_PREFIXES` | #1 | 削除対象属性プレフィックスのリスト（`'on'`） |
| `URL_ATTRS` | #1 | URL バリデーション対象の属性のセット（`href`, `src` など） |

---

## webview/core/serialize.ts

**役割**: contenteditable の DOM を保存用 HTML に変換する。ブラウザが追加したプレースホルダー `<br>` を除去し、シリアライズを安定させる。

| 関数/定数 | 機能# | 要件 |
|---|---|---|
| `formatForSerialize(root)` | #10 | アクティブブロックマーキング → クローン → `pruneEmptyBlocks()` → `fillMissingBlockGaps()` → `innerHTML` を返す |
| `pruneEmptyBlocks(scope)` | #10 | `<p><br></p>` → `<p></p>` に変換する。アクティブブロックは `<br>` のみ除去して書式ラッパーは保持する |
| `fillMissingBlockGaps(parent)` | #10 | 隣接するブロック要素間に空白テキストノードがない場合、既存のインデントパターンを参考に補完する |
| `collapsedActiveEmptyBlock(root)` | #10 | カーソルが空のブロック内にあればその要素を返す（書式継承 Enter 用のアクティブブロック特定） |
| `isBlockEffectivelyEmpty(block)` | #10 | ブロックが実質的に空（`<br>` とインラインラッパーのみ）かどうかを判定する |
| `EMPTYABLE_BLOCK_TAGS` | #10 | 空ブロックプルーニングの対象タグのセット（`P`, `H1-H6`, `BLOCKQUOTE`, `DIV`, `LI`） |
| `OPAQUE_TAGS` | #10 | 内部をそのまま保持するタグのセット（`PRE`, `TABLE`, `THEAD`, `TBODY` など） |

---

## webview/core/selection.ts

**役割**: DOM 再マウント後のカーソル位置復元。空白のみのテキストノードを除外した「有意インデックス」でパスをエンコードする。

| 関数/インターフェース | 機能# | 要件 |
|---|---|---|
| `captureSelection(root)` | #10 | 現在の選択範囲を `SavedSelection` としてエンコードする。ルート外の場合は `null` を返す |
| `restoreSelection(root, saved)` | #10 | エンコードされたパスをデコードして選択範囲を復元する。タイプ不一致で復元できない場合は `false` を返す |
| `SavedSelection` | #10 | anchor と focus の `SavedPosition` を持つインターフェース |
| `SavedPosition` | #10 | `path: number[]`（ルートからの有意インデックス列）、`nodeIndex`、`offset`、`isText` を持つインターフェース |
| `significantIndexOf(child)` | #10 | 親の子リスト中での有意インデックスを返す（空白のみテキストノードをスキップ）（内部関数） |
| `encodePosition(root, node, offset)` | #10 | ノードと文字オフセットを `SavedPosition` にエンコードする（内部関数） |
| `resolvePosition(root, pos)` | #10 | `SavedPosition` から `{ node, offset }` を解決する（内部関数） |

---

## webview/commands/inline-format.ts

**役割**: インライン書式のトグル・クリア・セグメント分割。選択範囲が複数ブロックにまたがる場合はセグメントに分割して各ブロック内で独立して処理する。

| 関数 | 機能# | 要件 |
|---|---|---|
| `toggleInline(tag, ctx)` | #2 | 選択範囲の全テキストが `tag` で覆われていれば除去、そうでなければ適用する |
| `clearFormatting(ctx)` | #2 | 装飾的インラインタグをアンラップし、完全に覆われた要素の `style`/`class` を削除する。`<a>` は除外 |
| `isRangeCovered(range, tagName, root)` | #2 | ツールバーのアクティブ状態判定用。選択範囲内の全テキストが `tagName` で覆われているか返す |
| `collectSegments(range, root)` | #2 | 選択範囲をセグメント境界（ブロック・`<comment>`）で分割し、独立した Range の配列を返す（内部関数） |
| `applyTagToSegment(seg, tag)` | #2 | 単一セグメントに `tag` ラッパーを適用する（内部関数） |
| `removeTagFromRange(range, tagName, root)` | #2 | `tagName` 要素を deepest-first で処理し、範囲との重なり方に応じて分割・除去する（内部関数） |
| `splitAtBoth(el, range)` | #2 | el が選択範囲の両側にはみ出す場合の3分割（内部関数） |
| `splitAtStart(el, range)` | #2 | el が選択範囲の左にはみ出す場合の分割（内部関数） |
| `splitAtEnd(el, range)` | #2 | el が選択範囲の右にはみ出す場合の分割（内部関数） |
| `normalizeInline(root, tagName)` | #2 | 空のインライン要素を削除し、隣接する同一タグをマージする（内部関数） |
| `SEGMENT_BOUNDARY_TAGS` | #2 | インライン書式が越えられない境界タグのセット（ブロック・テーブルセル・`COMMENT`） |

---

## webview/commands/block-format.ts

**役割**: カーソルが属するブロック要素のタグを変更する。

| 関数 | 機能# | 要件 |
|---|---|---|
| `setBlockTag(tag, ctx)` | #3 | カーソルから最近傍のブロック祖先を見つけ、新しいタグで置き換える。属性はコピーし内容を移動する |
| `insertHr(ctx)` | #3 | 現在のブロックの直後に `<hr>` と空の `<p>` を挿入する。元のブロックが空なら削除する |
| `BlockTag` | #3 | 変換可能なブロックタグの Union 型（`'p' \| 'h1' \| ... \| 'pre'`） |

---

## webview/commands/link.ts

**役割**: `<a href="...">` の挿入・更新・削除。

| 関数 | 機能# | 要件 |
|---|---|---|
| `insertLink(href, ctx)` | #4 | collapsed: 既存の `<a>` があれば更新/削除、なければ URL テキストの `<a>` を挿入する。非 collapsed: 交差する `<a>` をアンラップし、空でなければ新しい `<a>` でラップする |

---

## webview/commands/query.ts

**役割**: ツールバーの状態反映のための読み取り専用クエリ。DOM を変更しない。

| 関数 | 機能# | 要件 |
|---|---|---|
| `getCurrentBlockTag(node, root)` | #3 | ノードから最近傍のブロック祖先タグ名（小文字）を返す。ツールバードロップダウンの現在値表示に使用する |
| `findInlineAncestor(node, tagName, stopAt)` | #2, #4 | 指定タグ名の最近傍祖先要素を返す。ツールバーのアクティブ状態判定に使用する |

---

## webview/features/clipboard/copy.ts

**役割**: クリップボードへのコピー用 HTML 生成。選択範囲があれば範囲内のみ、なければ全体。

| 関数 | 機能# | 要件 |
|---|---|---|
| `prepareCopy(root, format)` | #7 | `currentHtml()` で HTML を生成し、`format === 'confluence'` なら `toConfluenceHtml()` を適用して返す |
| `expandToInlineWrappers(range, root)` | #7 | 選択範囲の境界がインラインラッパー（`<strong>` など）の端と一致する場合、そのタグを含むよう拡張する（内部関数） |

---

## webview/features/clipboard/confluence.ts

**役割**: Confluence 貼り付け用の HTML 変換。

| 関数 | 機能# | 要件 |
|---|---|---|
| `toConfluenceHtml(html)` | #7 | HTML 文字列に変換処理を適用して Confluence 互換文字列を返す |
| `rewriteComments(root)` | #7 | `<comment-body>` / `<comment-reply>` を削除し、`<comment>` タグをアンラップする |
| `ensureTableBorders(root)` | #7 | `border` 属性がない `<table>` に `border="1"` を追加する |
| `ensurePreHasCode(root)` | #7 | `<pre>` の内容が `<code>` でラップされていない場合にラップする |

---

## webview/features/clipboard/paste-sanitize.ts

**役割**: クリップボードからペーストされた HTML のノイズ削減（セキュリティサニタイズは `renderer.ts` が先行する）。

| 関数 | 機能# | 要件 |
|---|---|---|
| `cleanupPastedFragment(root)` | #8 | CF_HTML コメント削除 → Office ラッパー除去 → スタイル/クラス削減 → 裸の `<span>`/`<font>` アンラップを順に実行する |
| `removeCfHtmlComments(root)` | #8 | コメントノードを削除し、`StartFragment`/`EndFragment` マーカー周辺の余分な空白を除去する（内部関数） |
| `removeOfficeWrappers(root)` | #8 | `<o:p>` など名前空間付きタグをアンラップする（内部関数） |
| `stripStyleAndClass(root)` | #8 | `class` を全削除、`style` は `pruneStyle()` でプルーニングする（内部関数） |
| `isAllowedStyle(tag, property)` | #8 | タグとプロパティの組み合わせが許可リストに含まれるか判定する（内部関数） |
| `unwrapBareStyleWrappers(root)` | #8 | 属性がなくなった `<span>`/`<font>` をアンラップする（安定するまで繰り返す）（内部関数） |

---

## webview/features/comment/comment-dom.ts

**役割**: DOM をコメントのストアとして扱うヘルパー。`<comment>` / `<comment-body>` / `<comment-reply>` 要素の読み書き。

| 関数 | 機能# | 要件 |
|---|---|---|
| `newCommentId(root)` | #6 | ユニークな `c-xxxxxxxx` 形式のIDを生成する（衝突時は最大16回リトライ） |
| `findCommentById(root, id)` | #6 | ID で `<comment>` 要素を検索する |
| `getBody(comment)` | #6 | `<comment-body>` のテキストを返す |
| `setBody(comment, text)` | #6 | `<comment-body>` を作成または更新する。`<comment-reply>` の前に配置する |
| `getReplies(comment)` | #6 | `<comment-reply>` 要素の配列を返す |
| `addReply(comment, text)` | #6 | 新しい `<comment-reply>` を追加する |
| `updateReply(reply, text)` | #6 | `<comment-reply>` のテキストを更新する |
| `removeReply(reply)` | #6 | `<comment-reply>` を削除する |
| `commentsInDocumentOrder(root)` | #6 | `id` 属性を持つすべての `<comment>` 要素をドキュメント順に返す |
| `lockChildren(comment)` | #6 | `<comment-body>` と `<comment-reply>` を `contenteditable="false"` に設定する |

---

## webview/features/comment/comment-commands.ts

**役割**: コメントの追加・削除コマンド。

| 関数 | 機能# | 要件 |
|---|---|---|
| `addComment(ctx)` | #6 | 選択範囲が単一ブロック内にあることを確認し、`<comment>` でラップして `<comment-body>` を追加する。ブロック境界をまたぐ場合は `null` を返す |
| `removeComment(ctx, comment)` | #6 | `<comment-body>` / `<comment-reply>` を削除してから `<comment>` タグをアンラップする |
| `findCommentScopeAncestor(node, stopAt)` | #6 | コメントが属せる最近傍の「スコープ」ブロック要素を返す（内部関数） |
| `COMMENT_SCOPE_TAGS` | #6 | コメントを含めるブロックタグのセット（`BLOCK_TAGS` + `TD`, `TH`, `CAPTION`） |

---

## webview/features/table/table-model.ts

**役割**: colspan/rowspan を解決した論理グリッドモデルの構築。テーブル操作の基盤。

| 関数/型 | 機能# | 要件 |
|---|---|---|
| `buildTableModel(table)` | #5 | `<table>` 要素から colspan/rowspan を解決した `TableModel` を構築する |
| `findTable(node, stopAt)` | #5 | ノードから最近傍の `<table>` 祖先を返す |
| `findCell(node, stopAt)` | #5 | ノードから最近傍の `<td>`/`<th>` 祖先を返す |
| `findCellPosition(model, cell)` | #5 | セルの論理座標（row, col）を返す。アンカーでないセルや切り離されたセルには `null` を返す |
| `boundingRect(model, a, b)` | #5 | 2つのセルを含む最小の矩形 `CellRect` を返す |
| `tightenRect(model, rect)` | #5 | 矩形内の結合セルが矩形外にはみ出す場合に矩形を拡大して完全な矩形を返す |
| `anchorsInRect(model, rect)` | #5 | 矩形内のアンカーセルのみを返す（矩形から外れるセルは除外） |
| `TableModel` | #5 | `{ table, cols, rows, grid[][], trs[], sections[] }` を持つインターフェース |
| `LogicalCell` | #5 | `{ el, rowSpan, colSpan, anchorRow, anchorCol, section }` を持つインターフェース |

---

## webview/features/table/structure-commands.ts

**役割**: テーブル挿入・行列の追加削除・ヘッダー変換・テーブル削除・Tab ナビゲーション。

| 関数 | 機能# | 要件 |
|---|---|---|
| `insertTable(opts, ctx)` | #5 | 現在ブロックを分割してテーブルを挿入し、最初のセルにカーソルを移動する |
| `insertRow(cell, position)` | #5 | 指定セルの行の上または下に新しい行を挿入する。rowspan 伸長が必要なセルを調整する |
| `deleteRow(cell, ctx)` | #5 | 指定セルの行を削除する。rowspan の調整とセクション空化時の削除を行う。最後の行ならテーブルを削除する |
| `insertColumn(cell, position)` | #5 | 指定セルの列の左または右に新しい列を挿入する。colspan 伸長と colgroup の調整を行う |
| `deleteColumn(cell, ctx)` | #5 | 指定セルの列を削除する。最後の列ならテーブルを削除する |
| `convertRowToHeader(cell)` | #5 | 指定セルの行を `<thead>` に移動し、セルを `<th>` に変換する |
| `removeHeader(cell)` | #5 | `<thead>` の行を `<tbody>` に移動し、セルを `<td>` に変換する |
| `convertColumnToHeader(cell)` | #5 | 指定セルの列（tbody/tfoot のみ）を `<th scope="row">` に変換する |
| `convertColumnToBody(cell)` | #5 | 指定セルの列を `<td>` に戻す |
| `isColumnHeader(table, colIndex)` | #5 | 列がヘッダー列かどうかを判定する（メニューのトグル状態表示用） |
| `deleteTable(table, ctx)` | #5 | テーブルを削除し、元の位置に空の `<p>` を挿入する |
| `adjacentCell(cell, direction)` | #5 | DOM 順で次または前のセルを返す（Tab ナビゲーション用） |
| `appendRowAtEnd(table)` | #5 | テーブルの末尾に新しい行を追加して最初のセルを返す（Tab ナビゲーション用） |

---

## webview/features/table/merge-commands.ts

**役割**: テーブルセルの結合・分割。

| 関数 | 機能# | 要件 |
|---|---|---|
| `mergeCells(a, b)` | #5 | 2つのセルを含む矩形を計算し、矩形内の全セルを左上セルに集約して結合する |
| `splitCell(cell)` | #5 | 結合セルを元の rowspan × colspan 個のセルに分割する |

---

## webview/ui/toolbar.ts

**役割**: エディタ上部のスティッキーツールバー。ボタンの生成・アクティブ状態の管理・ブロックタイプドロップダウン。

| 関数/ロジック | 機能# | 要件 |
|---|---|---|
| `createToolbar(root, opts)` | #2, #3, #4, #5, #6, #7 | ツールバー要素を生成してすべてのボタンをアセンブルし返す |
| `buildBlockDropdown(...)` | #3 | `position:fixed` を使うブロックタイプドロップダウンを生成する。選択前に Range を保存し、選択後に復元してから `setBlockTag()` を実行する |
| `selectionchange` ハンドラ | #2, #3, #4 | カーソル移動に応じて Bold/Italic/Strike/Code/CodeBlock/Link ボタンのアクティブ状態を更新する |
| `textBtn(label, title, onClick, id)` | UI | テキストラベルのツールバーボタンを生成する |
| `iconBtn(svgHtml, title, onClick, ...)` | UI | SVG アイコンのツールバーボタンを生成する |

---

## webview/shared/constants.ts

**役割**: コマンド層全体で共有するタグ名定数。

| 定数 | 機能# | 要件 |
|---|---|---|
| `BLOCK_TAGS` | #2, #3, #9 | ブロック祖先探索に使用するタグセット（大文字: `P`, `H1-H6`, `BLOCKQUOTE`, `PRE`, `DIV`, `LI`） |
| `INLINE_FORMAT_TAGS` | #2, #9 | 書式継承 Enter のタグセット（`STRONG`, `EM`, `CODE`, `S`） |

---

## webview/shared/dom-utils.ts

**役割**: DOM 走査・変換の共通ユーティリティ。コマンド層全体で使用される。

| 関数 | 機能# | 要件 |
|---|---|---|
| `findAncestor(node, tagName, stopAt)` | #2, #4, #6 | 指定タグ名の最近傍祖先要素を返す。`stopAt` 以上には上らない |
| `findBlockAncestor(node, stopAt)` | #3, #5, #9 | `BLOCK_TAGS` に属する最近傍祖先要素を返す |
| `unwrap(el)` | #2, #4, #6 | 要素の子ノードを親に昇格させ、要素自体を削除する |
| `nodeDepth(node, root)` | #2 | ルートからのステップ数を返す（deepest-first ソート用） |
| `isBlockEmpty(el)` | #3 | 子要素がなく空白のみのテキストを持つブロックかを判定する |
| `isBlockEmptyOrStubBr(el)` | #5 | `isBlockEmpty` または子が `<br>` のみのブロックかを判定する |
| `surroundSimple(range, wrapper)` | #4, #6 | `surroundContents()` を試み、失敗した場合は `extractContents()` + `insertNode()` にフォールバックする |
| `selectContents(sel, el)` | #4, #6 | `el` の内容全体を選択する |
| `resolveToTextBoundary(container, offset)` | #2, #4 | 要素ノードのオフセットをテキストノードレベルに解決する（アンラップ後の Range 再構築で使用） |
