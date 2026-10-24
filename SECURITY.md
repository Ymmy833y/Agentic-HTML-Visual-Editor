# Security Policy

## Supported versions

Only the latest released version of Agentic HTML Visual Editor (AHVE) receives security fixes.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's
[Private vulnerability reporting](https://github.com/Ymmy833y/Agentic-HTML-Visual-Editor/security/advisories/new).
Do not open a public issue or pull request for a suspected vulnerability.

We aim to acknowledge a report within 7 days. We will tell you whether we treat it as a vulnerability,
and we will coordinate the timing of any disclosure with you.

Please include the AHVE version, the steps to reproduce, and the HTML file that triggers the problem if there is one.

## Trust boundaries

| Component | Trust | Protection |
| --- | --- | --- |
| Author of the HTML document (the user, or the user's agent) | Trusted | None beyond the layers below. AHVE does not defend against a trusted author's own content. |
| HTML opened in the editor | Not trusted to run code | The webview Content Security Policy (CSP) and the sanitizer keep scripts, event handlers and dangerous URL schemes from running. |
| Webview | Isolated | A strict CSP (`default-src 'none'`, per-render script nonce) and no file I/O. It reaches the extension host only through validated messages. |
| Extension host | Privileged | Makes no network requests, sends no telemetry, and reads or writes only the opened document, its backups and the file the user chooses for PDF export. |

## Designed behavior

The following are intended behavior, not vulnerabilities. They follow from the trust boundary above.

| Behavior | Why it is by design |
| --- | --- |
| A document's `img` elements and `url()` values in `style` attributes load from any `http` or `https` server when the document is opened, including in Restricted Mode. | Images are part of the specified document display. The server learns that the document was opened. Scripts still cannot make network requests. |
| Copying a code block (copy button, or Ctrl+C as text) includes text hidden with CSS such as `display: none`. | The copy source is the document text, and the document author is trusted. |
| Ctrl+click on a non-relative link passes the `href` to VS Code's default link handling for any scheme except `command:`, which is disabled. | The author is trusted to write the links they intend. The confirmation shown for such links belongs to VS Code. |
| The sanitizer does not inspect the `to`, `from`, `by` and `values` attributes of SVG animation elements for dangerous URL schemes. | The author is trusted, and the CSP still blocks script execution. |

A report that goes beyond these, for example one that runs script in the webview, bypasses the CSP,
or makes the extension host read or write an unintended file, is in scope.
