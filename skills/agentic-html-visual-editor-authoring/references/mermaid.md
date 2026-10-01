# Mermaid diagrams

How to write a diagram that Agentic HTML Visual Editor draws, and what happens to it on save and on copy.

## Writing a diagram

Write a diagram as Mermaid source text inside a `pre`. The editor recognizes two forms and keeps the one you chose.

A `pre` whose `class` contains `mermaid`:

```html
<pre class="mermaid">flowchart LR
A[Draft] --> B{Approved?}
B -->|yes| C[Publish]
B -->|no| A
</pre>
```

A `pre` whose only child element is a `code` whose `class` contains `language-mermaid`:

```html
<pre><code class="language-mermaid">sequenceDiagram
Agent->>Human: report.html
Human-->>Agent: comments
</code></pre>
```

Nothing else is drawn as a diagram. Both class names survive a paste into the editor, so a pasted diagram stays a diagram.

The source is part of the HTML, so write `&` as `&amp;` and `<` as `&lt;`:

```html
<pre class="mermaid">flowchart LR
A["Size &lt; 10 MB"] --> B["Save &amp; close"]
</pre>
```

`>` can stay as it is. On a line that the editor saves after an edit, it appears as `&gt;`, which means the same.

## Saving, copying, and limits

The editor shows the block as the drawn diagram. The drawing is for display only:

- The saved HTML holds the source block. The drawn diagram is never written to the file.
- Copied HTML holds the source block too, not the drawing.

So keep the source block as the diagram. Do not put a rendered SVG or an image of the diagram in its place.

The editor draws with the Mermaid that it bundles, in a configuration that runs no script and fetches nothing from outside, and it matches the light or dark theme of VS Code. Do not add a `script` tag or a link to a Mermaid CDN. A `script` in the body keeps the whole document from opening.

A diagram is not drawn, and an error is shown in its place, when any of these is true:

- The source is longer than 50,000 characters.
- The diagram has more than 500 edges.
- The syntax is invalid.

Split a larger picture into several diagrams.
