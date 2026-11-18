# Replying to comments

How to answer the comments in a document without reading all of it, and how to write the content of an entry.

## Answering comments

When you only answer comments, do not read the whole file. Work from the threads that wait for your answer:

1. List them:

   ```bash
   python3 scripts/list_comments.py --status awaiting-reply path/to/document.html
   ```

   A thread waits for your answer when it is unresolved and its last entry is not by `ai`. Each item gives `line`, the line of the file where the comment starts, the annotated text as `target`, and the thread as `entries`. [comments.md](comments.md#listing-and-copying) describes every field. When the output is `[]`, there is nothing to answer.
2. Read the file only around each `line`, such as a few lines before and after it. Read other parts only when the answer needs them.
3. Write the content of the reply as [Writing an entry](#writing-an-entry) describes.
4. Append it with the bundled script, as [Appending a reply](#appending-a-reply) describes.

When answering a thread means changing the document itself, or raising a new point in a new comment, you are no longer only answering. Follow the workflow in SKILL.md, which reads the whole file, and write those changes by hand.

## Writing an entry

The body and the replies of a comment are its entries. An entry takes the same formatting as the document body:

- Write text and inline formatting directly in the entry, as you write the text of a paragraph: `&` and `<` escaped as in any HTML text, and the inline markup described in [formatting.md](formatting.md), such as `strong`, `em`, `code`, or `a` with an `href`.
- Write a line break as a line break in the text, not as `br`. The editor shows each line of an entry as a paragraph.
- When an entry needs a block other than a paragraph, such as a heading, a list, a table, a code block, an alert, a collapsible section, or a diagram, put its whole content inside one `template` element, and write it there as blocks, the way the document body is written and as [formatting.md](formatting.md) describes. Put nothing else in that entry, apart from whitespace around the `template`. A block written directly inside an entry would end the paragraph the comment sits in when the document is opened again.
- Do not put a comment inside an entry. The editor shows it as its text only.

### Choosing a format

Write an entry as plain text only when it is a short answer of one or two sentences. Give anything longer a structure that the reader can take in at a glance:

| Content | Format |
| --- | --- |
| Several points to confirm, or steps | A numbered list |
| Options or values to compare | A table |
| An assumption, a risk, or a caveat | An alert |
| The source of a statement | A link |
| The conclusion | Bold text |

Links and bold text are inline formatting and need no `template`. Lists, tables, and alerts are blocks and go inside one.

The content of an entry with a table and its conclusion:

```html
<template>
<p>The interval is not decided yet. The two candidates:</p>
<table>
<tbody>
<tr><th scope="col">Interval</th><th scope="col">Load</th><th scope="col">Stale data</th></tr>
<tr><td>Every 30 minutes</td><td>Twice the current load</td><td>Up to 30 minutes old</td></tr>
<tr><td>On each deploy</td><td>The lowest</td><td>Until the next deploy</td></tr>
</tbody>
</table>
<p><strong>Every 30 minutes is suggested</strong>, because stale data is the larger risk.</p>
</template>
```

The content of an entry with an alert and a numbered list:

```html
<template>
<blockquote data-alert="warning">
<p>Measured on a test project of 200 files only.</p>
</blockquote>
<p>Please confirm:</p>
<ol>
<li>The number of files in the largest project.</li>
<li>Whether a minute is acceptable for that project.</li>
</ol>
</template>
```

## Appending a reply

Append a reply with the bundled script instead of editing the file:

```bash
python3 scripts/add_reply.py --id c-a1b2c3d4 --reply 'Changed to every 30 minutes.' path/to/document.html
```

- `scripts/add_reply.py` is relative to the directory of this skill. It needs Python 3.11 or later. On Windows the interpreter is usually `python` instead of `python3`.
- The script adds the reply as the last entry of the comment, with `data-author="ai"`, `contenteditable="false"`, and the current time, and changes nothing else in the file. It drops whitespace around the reply and writes the line breaks in it with the line ending of the file.
- Pass the content with `--reply`. When your shell would change it, as Windows PowerShell 5.1 drops the double quotation marks in arguments, write the content to a UTF-8 file and pass that file with `--reply-file` instead.
- It prints a JSON array of the problems that the reply adds to the comments, in the form that `scripts/check_comments.py` uses ([comments.md](comments.md#checking)). A reply that adds an `error` is not written and the exit code is 1: fix the content and run the script again. A `warning` alone does not stop it, and the exit code is 0.
- When a file cannot be read, no comment or more than one comment has the ID, the comment has no end tag, the reply is empty, the reply holds a tag that [html-document.md](html-document.md#elements-and-attributes) forbids in the body, such as `meta` or `script`, anywhere in its text, even in an attribute value, or markup in the reply would reach beyond it, it prints the reason to standard error, prints no JSON, changes nothing, and exits with code 1. Markup reaches beyond a reply when the reply does not close a `template` or an inline element with its own end tag, leaves a tag without its closing `>` or a quotation mark open, or holds an end tag such as `</comment>` that closes the comment or the reply early. Close each element that a reply opens with its own end tag, and write each `<` of its text as `&lt;`.
- The script also refuses a reply with markup that a browser can read as reaching beyond the reply in a way that the script cannot follow: `<!`, as in an HTML comment, `<?`, `</` not followed by a letter, and the start tags of `svg`, `math`, `xmp`, `noembed`, `noframes`, and `plaintext`. Leave HTML comments and these elements out of a reply. On some versions of Python, it also refuses a start tag that Python ends at a different `>` from a browser or reads as text, as those versions can when an attribute has more than one `=`, or whitespace other than a space, a tab, or a line break around `=`. Write each attribute as `name="value"`.
- When the comment is inside a link, as it is when a person comments on part of the text of a link, the script also refuses a reply with a link outside a `template`, because a browser closes the outer link, and the comment with it, at the link in the reply. Write such a link as text, or put the content of the reply in a `template` as a paragraph.

## Resolving

Resolving a comment is usually the human reviewer's decision. Confirm with the user before you mark one as resolved, and mark it as [comments.md](comments.md#appending-and-resolving) describes.
