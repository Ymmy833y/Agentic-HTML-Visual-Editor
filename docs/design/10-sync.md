# 10. Extension-Webview 間同期

> 機能の存在については [README_ja.md](../../README_ja.md) を参照してください。このドキュメントは同期メカニズムの振る舞いを記述します。

## 概要

ユーザーが Webview で編集した内容を VS Code のテキストドキュメントに反映し、テキストドキュメントが外部で変更された場合に Webview に反映する双方向同期。エコーループを防ぐ `suppressEcho` フラグと、DOM 再マウント後のカーソル位置復元が中心的な仕組み。

---

## 同期のフロー

### Webview → Extension（ユーザーの編集）

```
ユーザーがタイプ
    │
    ▼ input イベント（または notifyChanged() の直接呼び出し）
    │
    ▼ scheduleChange() — 250ms デバウンス
    │
    ▼ onChange コールバック
    │
    ▼ serialize() — formatForSerialize(root)
    │
    ▼ lastSyncedHtml と比較（差分がない場合は送信しない）
    │
    ▼ vscode.postMessage({ type: 'edit', html })
    │
    ▼ Extension: suppressEcho = true
    ▼ Extension: applyEdit() — WorkspaceEdit でファイル全体を置換
    ▼ Extension: suppressEcho = false
```

### Extension → Webview（外部変更）

```
外部でファイルが変更
    │
    ▼ onDidChangeTextDocument イベント
    │
    ▼ suppressEcho チェック（true なら無視 → エコーループ防止）
    │
    ▼ vscode.postMessage({ type: 'documentChanged', html })
    │
    ▼ Webview: lastSyncedHtml と比較（一致する場合は無視）
    │
    ▼ mountFromSource(html) — DOM を再マウント
```

---

## suppressEcho フラグ

Webview が `edit` メッセージを送ると、Extension が `applyEdit()` を実行してファイルを変更する。この変更は `onDidChangeTextDocument` イベントを発火させ、`documentChanged` メッセージが Webview に届いてしまう。このエコーを防ぐため：

- Extension は `applyEdit()` の実行中（`await` の前後）に `suppressEcho = true` を設定する
- `suppressEcho` が `true` の間は `documentChanged` メッセージを送らない
- `applyEdit()` の完了（成功または失敗）後に `suppressEcho = false` に戻す

---

## デバウンス（250ms）

連続入力のたびに Extension との通信が発生しないよう、変更通知は 250ms のデバウンスで遅延される。

- `scheduleChange()` は既存のタイマーをキャンセルして新しいタイマーをセットする
- `editor.flush()` を呼ぶとタイマーをキャンセルして即座に `onChange()` を実行する
- `beforeunload` イベントで `editor.flush()` が呼ばれ、Webview が閉じられる直前の未送信変更を確実に Extension に送る

---

## HTML シリアライズ

`formatForSerialize(root)` は contenteditable な DOM を保存用 HTML 文字列に変換する。主な処理：

1. **アクティブブロックのマーキング**: カーソルが collapsed で空のブロック内にある場合、そのブロックに一時的な `data-hw-active` 属性を付与する
2. **クローン**: `root.cloneNode(true)` でライブ DOM をコピーする（ライブ DOM への変更なし）
3. **空ブロックのプルーニング**: `<p><br></p>` → `<p></p>`（アクティブブロックは `<br>` を除去するが書式ラッパーは保持）
4. **ブロック間の空白補完**: 隣接するブロック要素間に空白テキストノードがない場合、既存のインデントパターンを参考にして補完する
5. `<pre>` と `<table>` の内部はそのまま保持する（opaque）

---

## カーソル位置の復元（selection.ts）

`documentChanged` で DOM が再マウントされると、ブラウザの Selection オブジェクトが無効になる。以下の方式でカーソル位置を復元する：

### エンコード（captureSelection）

現在の選択範囲を「有意インデックスパス」でエンコードする：
- 空白のみのテキストノードを「有意でない」として除外する
- ルートからターゲットノードへのパスを、有意な子のインデックス列で表現する

### なぜ「有意インデックス」が必要か

Enter で新しいブロックを作成すると、ライブ DOM にはブロック間に空白テキストノードがない。しかし `formatForSerialize()` はブロック間に空白テキストノードを挿入する。このため `documentChanged` で DOM を再マウントすると余分な空白テキストノードが増え、通常の子インデックスではカーソル位置がずれる。有意インデックスはこの非対称な往復を吸収する。

### デコード（restoreSelection）

エンコードされたパスをたどって新しい DOM 内のターゲットノードを探し、`selection.setBaseAndExtent()` で選択範囲を復元する。タイプ不一致（テキストノードが期待された位置に要素ノードがあるなど）の場合は復元を諦める。

---

## lastSyncedHtml

最後に Extension に送信した（またはExtensionから受信した）HTML を保持する変数。以下の目的に使用：

- `edit` メッセージの送信前に変更があるか確認する（不要な送信を抑制）
- `documentChanged` 受信時に実際に内容が変わっているか確認する（DOM 再マウントを抑制）

---

## 関連機能

- [#1 エディタ起動・表示](./01-editor-bootstrap.md) — `init` メッセージによる初期化フロー
- [#7 クリップボード・コピー](./07-clipboard-copy.md) — `clipboardWrite` メッセージの Extension 側処理
