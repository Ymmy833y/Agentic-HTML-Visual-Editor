---
name: agentic-html-visual-editor-authoring
description: Write, edit, and review HTML documents that are opened in the Agentic HTML Visual Editor extension for VS Code. Use when creating or changing an HTML deliverable such as design notes, a report, or a task list for that editor, when adding or answering its inline comment annotations, and when listing the comments in a document, for example only the unresolved ones.
compatibility: The comment listing script (scripts/list_comments.py) requires Python 3.11 or later. Everything else works without it.
---

# Authoring documents for Agentic HTML Visual Editor

Agentic HTML Visual Editor is a VS Code extension that shows an `.html` file as an editable document. An agent writes the file, and a human reads it, edits it, and leaves review comments in the same file.

The plain HTML file on disk is the only source of truth. The editor keeps no sidecar file and no format of its own, so everything that has to last, comments included, must be in the HTML.

## When to use

Use this skill when you create, edit, or review an HTML deliverable that will be opened in Agentic HTML Visual Editor: design notes, research reports, task lists, review results. It also covers how to mark what you added and removed when you revise such a document.

Do not use it for general web pages. It describes what this editor accepts, not how to build a site.

## Workflow

1. Identify the target. Find out which file you are writing and whether it already exists. Read an existing file in full before you change it, including its comments.
2. Read the references that the task needs, and only those. [References](#references) says when to read each one.
3. Write or edit the HTML.
4. Check the result against [Before you deliver](#before-you-deliver).

## Core rules

- **The HTML is the record.** Put the content and the comments in the HTML file itself. Do not create a separate file, list, or log that holds comments or the state of the document.
- **Keep existing comments.** Do not edit, reorder, delete, or re-stamp a comment, its body, or its replies. To answer one, append a reply. Resolving a comment is usually the human reviewer's decision, so it is best to confirm with the user before you mark one as resolved.
- **Do not invent rules.** Write only the markup that the references describe. If they do not say that the editor supports a tag, an attribute, or a behavior, do not assume that it does, and do not make up a convention of your own.

## References

Paths are relative to the directory of this skill.

- Read [references/html-document.md](references/html-document.md) when you create a new document, or when you add or change tags and attributes. It covers the document skeleton, the allowed and forbidden tags, the attributes the editor disables, and how the editor formats HTML on save.
- Read [references/formatting.md](references/formatting.md) when you write tables, images, collapsible sections, or alerts, or when the content will be pasted into the editor. It covers text and block markup, `details`, alert blockquotes, and the styles that survive a paste.
- Read [references/mermaid.md](references/mermaid.md) when you create or change a Mermaid diagram.
- Read [references/comments.md](references/comments.md) when you create a comment, reply to one, or need to know what the comments in a document say.
- Read [references/change-marks.md](references/change-marks.md) when you revise a document that a person reviews, to mark what you added and removed so that the editor shows each change and lets it be accepted or rejected.

## Listing comments

To see the comments of one or more documents without opening the editor, run the bundled script:

```bash
python3 scripts/list_comments.py --status unresolved path/to/document.html
```

- `scripts/list_comments.py` is relative to the directory of this skill. Give each document as an absolute path, or as a path relative to the directory you run the command in.
- `--status` takes `all` (the default), `unresolved`, or `resolved`. You can pass several files.
- The script prints a JSON array to standard output and never changes a file. When it fails, it prints the reason to standard error, prints no JSON, and exits with code 1.
- It needs Python 3.11 or later. On Windows the interpreter is usually `python` instead of `python3`.

[references/comments.md](references/comments.md) describes the fields of the JSON.

## Before you deliver

- [ ] The markup follows the references you read for this task.
- [ ] Every diagram is a Mermaid source block, not a rendered image or SVG.
- [ ] Every comment that was in the document is still there, and its body and replies are unchanged. Your answers are appended replies.
