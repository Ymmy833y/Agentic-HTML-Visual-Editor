// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  assertClipInView,
  readIntegrationTestVsCodeVersion,
  renderBannerHtml,
} from '../../scripts/release/readme-images.mjs';

describe('VS Code version for the README screenshots', () => {
  it('is the version that .vscode-test.mjs pins for the integration tests', async () => {
    const config = readFileSync(new URL('../../.vscode-test.mjs', import.meta.url), 'utf8');
    const pinned = /^\s*version:\s*'(\d+\.\d+\.\d+)'/m.exec(config)?.[1];

    expect(pinned).toBeDefined();
    expect(await readIntegrationTestVsCodeVersion()).toBe(pinned);
  });
});

describe('README banners', () => {
  it('puts the escaped product name and tagline in the header, and no wording in the footer', () => {
    const words = { title: 'A & B <Editor>', tagline: 'Humans "and" AI' };

    const header = renderBannerHtml({ kind: 'header', ...words });
    const footer = renderBannerHtml({ kind: 'footer', ...words });

    expect({
      title: header.includes('A &amp; B &lt;Editor&gt;'),
      tagline: header.includes('Humans &quot;and&quot; AI'),
      unescaped: header.includes('<Editor>'),
      footerText: footer.includes('<text'),
    }).toEqual({ title: true, tagline: true, unescaped: false, footerText: false });
  });
});

describe('crop of a README image', () => {
  // The visible part of the document: the toolbar ends at 100 and the webview at 900.
  const view = { top: 100, bottom: 900 };

  it('does not throw for a crop whose top and bottom fall exactly on the bottom of the toolbar and of the webview', () => {
    expect(() => assertClipInView('diagrams.png', { x: 0, y: 100, width: 400, height: 800 }, view)).not.toThrow();
  });

  it('throws an error naming the image for a crop whose top is above the bottom of the toolbar', () => {
    expect(() => assertClipInView('diagrams.png', { x: 0, y: 99, width: 400, height: 300 }, view)).toThrow(
      /diagrams\.png/,
    );
  });

  it('throws an error naming the image for a crop whose bottom is below the bottom of the webview', () => {
    expect(() => assertClipInView('tables.png', { x: 0, y: 500, width: 400, height: 401 }, view)).toThrow(
      /tables\.png/,
    );
  });
});
