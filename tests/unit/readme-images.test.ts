// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { assertClipInView, renderBannerHtml } from '../../scripts/release/readme-images.mjs';

describe('README のバナー', () => {
  it('ヘッダーは製品名とキャッチコピーを HTML として逃がして含み、フッターは文言を含まない', () => {
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

describe('README の画像の切り抜く範囲', () => {
  // 文書の見えている範囲：ツールバーの下端が 100、webview の下端が 900。
  const view = { top: 100, bottom: 900 };

  it('上端がツールバーの下端に、下端が webview の下端にちょうど重なる範囲では例外を投げない', () => {
    expect(() => assertClipInView('diagrams.png', { x: 0, y: 100, width: 400, height: 800 }, view)).not.toThrow();
  });

  it('上端がツールバーの下端より上にある範囲では、画像の名前を含む例外を投げる', () => {
    expect(() => assertClipInView('diagrams.png', { x: 0, y: 99, width: 400, height: 300 }, view)).toThrow(
      /diagrams\.png/,
    );
  });

  it('下端が webview の下端より下にある範囲では、画像の名前を含む例外を投げる', () => {
    expect(() => assertClipInView('tables.png', { x: 0, y: 500, width: 400, height: 401 }, view)).toThrow(
      /tables\.png/,
    );
  });
});
