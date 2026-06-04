# 06. コメント機能

> 機能の存在については [README_ja.md](../../README_ja.md) を参照してください。このドキュメントは振る舞いの仕様を記述します。

## 概要

テキストに対してインラインのコメントアノテーションを付与する。コメントはカスタムHTMLタグとして HTML ファイル内に直接保存され、AI も読み取れる形式で記録される。ポップアップでコメントの追加・返信・削除ができる。

---

## コメントの DOM 構造

```html
<comment id="c-xxxxxxxx">
  対象テキスト
  <comment-body contenteditable="false">コメント本文</comment-body>
  <comment-reply contenteditable="false">返信1</comment-reply>
  <comment-reply contenteditable="false">返信2</comment-reply>
</comment>
```

- `<comment>` 要素: ハイライト対象のテキストを囲む。8文字のランダムな英数字からなる ID を持つ
- `<comment-body>`: コメント本文（最初の1つ）
- `<comment-reply>`: 返信（複数可）
- `<comment-body>` と `<comment-reply>` は `contenteditable="false"` に設定され、通常の編集操作では変更できない

---

## 前提条件・入力

- テキストが選択されている（collapsed は不可）
- 以下のいずれかの操作：
  - ツールバーの「Comment」ボタン
  - フローティングメニューの「Comment」ボタン

---

## 振る舞い

### コメントの追加

1. 選択範囲の開始位置と終了位置が同じブロック要素内にあるか確認する（`P`, `H1`–`H6`, `BLOCKQUOTE`, `PRE`, `DIV`, `LI`, `TD`, `TH`, `CAPTION` のいずれか）
2. ブロック境界をまたぐ場合はコメントを作成しない（null を返す）
3. ユニーク ID を生成する（`c-` + 8文字のランダム英数字。衝突時は最大16回リトライ）
4. 選択範囲を `<comment id="c-xxxxxxxx">` でラップする
5. 空の `<comment-body>` を追加し、`contenteditable="false"` を設定する
6. 選択範囲をコメント要素全体に変更する
7. コメントポップアップが表示される

### コメントポップアップの操作

- 既存のコメントハイライトをクリックするとポップアップが開く
- ポップアップでコメント本文の入力・編集ができる
- 「Reply」ボタンで返信を追加できる
- 返信は個別に削除できる
- コメント本文が空の状態でポップアップを閉じると、コメントを削除するか確認される（実装依存）

### コメントの削除

- コメントポップアップから削除操作を実行する
- `<comment-body>` と `<comment-reply>` を削除し、`<comment>` タグをアンラップする（対象テキストはそのまま残る）

---

## Confluence コピー時の挙動

- `toConfluenceHtml()` が呼ばれると、`<comment-body>` / `<comment-reply>` が削除され、`<comment>` タグがアンラップされる
- 結果として、Confluence に貼り付けたときはコメントアノテーションなしの純粋なテキストが表示される

---

## 出力・副作用

- DOM に `<comment>` / `<comment-body>` タグが追加または削除される
- コメント追加・削除後に `editor.notifyChanged()` が呼ばれ、250ms デバウンス後に Extension に同期される
- HTML ファイルにカスタムタグが保存されるため、テキストエディタで開いてもコメント構造が見える

---

## 制約・非対応

- ブロック境界をまたぐコメントは作成できない
- コメントは入れ子にできない（`<comment>` の中にさらに `<comment>` を作ることはできない）
- 通常の `contenteditable` による編集で `<comment-body>` / `<comment-reply>` の内容は変更できない（専用ポップアップのみ）

---

## 関連機能

- [#2 インライン書式設定](./02-inline-format.md) — `<comment>` 要素はセグメント境界として扱われ、コメントをまたいだインライン書式は適用されない
- [#7 クリップボード・コピー](./07-clipboard-copy.md) — Confluence コピー時のコメント除去
