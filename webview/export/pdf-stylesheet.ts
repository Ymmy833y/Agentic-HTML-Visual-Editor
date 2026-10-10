// Referenced here so that every project that compiles this file also sees the declaration of the imports.
/// <reference path="./stylesheet-text.d.ts" />
import baseText from '../ui/base.css';
import documentStylesText from '../ui/document-styles.css';
import themeTokensText from '../ui/theme-tokens.css';

/**
 * The rules that style the document, as text: the theme tokens, the base styles and the document styles, in the order
 * the bundled stylesheet has them.
 *
 * The copy html2canvas-pro draws lives in a frame that VS Code's service worker does not serve, so the stylesheet link
 * it copies loads empty there. The copy is given these rules instead, through a constructed stylesheet. The rules of
 * the extension's own interface are left out, because the copy keeps only the editor root.
 */
export const PDF_STYLESHEET_TEXT = [themeTokensText, baseText, documentStylesText].join('\n');
