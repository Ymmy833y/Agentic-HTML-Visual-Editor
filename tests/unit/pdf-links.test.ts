// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { assignLinksToPages, classifyLinkHref } from '../../webview/export/pdf-links';
import type { PdfLinkArea } from '../../webview/export/pdf-links';

describe('telling where a link of the PDF leads', () => {
  it('carries every other href as written without its surrounding whitespace and reads links starting with # as links inside the document', () => {
    expect([
      classifyLinkHref('https://example.com/a?b=1#c'),
      classifyLinkHref(' ../notes/plan.html#goal '),
      classifyLinkHref('#section%201'),
    ]).toEqual([
      { kind: 'href', href: 'https://example.com/a?b=1#c' },
      { kind: 'href', href: '../notes/plan.html#goal' },
      { kind: 'anchor', id: 'section 1' },
    ]);
  });

  it('carries a root-relative href as written, for the host to resolve from the workspace folder', () => {
    expect(classifyLinkHref('/docs/plan.html')).toEqual({ kind: 'href', href: '/docs/plan.html' });
  });

  it('gives no target to empty links and to a bare #', () => {
    expect([classifyLinkHref(''), classifyLinkHref('  '), classifyLinkHref('#')]).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });
});

describe('putting links on pages', () => {
  const href = { kind: 'href', href: 'https://example.com/' } as const;

  it('puts each area on the page holding its top, scaled and measured from the top of that page', () => {
    const areas: PdfLinkArea[] = [
      { top: 10, left: 20, width: 30, height: 15, target: href },
      { top: 1200, left: 5, width: 40, height: 15, target: href },
    ];

    expect(assignLinksToPages(areas, [0, 1000], 1500, 2)).toEqual([
      [{ x: 40, y: 20, width: 60, height: 30, target: href }],
      [{ x: 10, y: 400, width: 80, height: 30, target: href }],
    ]);
  });

  it('cuts an area at the bottom of its page', () => {
    const areas: PdfLinkArea[] = [{ top: 990, left: 0, width: 10, height: 20, target: href }];

    expect(assignLinksToPages(areas, [0, 1000], 1500, 1)[0]).toEqual([
      { x: 0, y: 990, width: 10, height: 10, target: href },
    ]);
  });

  it('turns the position a link inside the document leads to into the page holding it and the height on that page', () => {
    const areas: PdfLinkArea[] = [
      { top: 10, left: 0, width: 10, height: 10, target: { kind: 'position', y: 2100 } },
      { top: 2500, left: 0, width: 10, height: 10, target: { kind: 'position', y: 0 } },
    ];

    expect(assignLinksToPages(areas, [0, 1000, 2000], 3000, 2).map((links) => links.map((link) => link.target)))
      .toEqual([[{ kind: 'page', pageIndex: 2, y: 200 }], [], [{ kind: 'page', pageIndex: 0, y: 0 }]]);
  });
});
