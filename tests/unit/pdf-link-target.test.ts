// @vitest-environment node
import { describe, expect, it } from 'vitest';

import type { PdfPageLink } from '../../common/index';
import { resolvePdfLinkTargets, toRelativeLinkReference } from '../../src/export/pdf-link-target';
import type { LinkLocation } from '../../src/export/pdf-link-target';
import type { LinkResolveHost, LinkTargetCheck } from '../../src/link/relative-link-opener';

const FILE_DOCUMENT = { scheme: 'file', authority: '' };

/**
 * Returns where a PDF saved at a path of the local file system is.
 *
 * @param path The path of the PDF.
 */
function savedAt(path: string): LinkLocation {
  return { ...FILE_DOCUMENT, path };
}

/**
 * Creates ports bound to `/ws/docs/report.html` in the workspace folder `/ws`, where every file exists unless the check
 * is given.
 *
 * @param checked Where each checked path is recorded.
 * @param check What the check of a file answers, or throws.
 */
function createHost(
  checked: string[] = [],
  check: () => Promise<LinkTargetCheck> = () => Promise.resolve({ kind: 'file' }),
): LinkResolveHost {
  return {
    documentPath: '/ws/docs/report.html',
    belongsToWorkspaceFolder: () => true,
    resolveScopeDepth: () => 1,
    checkLinkTarget: (targetPath) => {
      checked.push(targetPath);
      return check();
    },
  };
}

/**
 * Decides the targets of the pages, collecting the lines recorded for maintainers.
 *
 * @param pages The pages.
 * @param host Ports bound to the document.
 * @param lines Where the recorded lines go.
 */
function resolveTargets(
  pages: readonly { readonly links: readonly PdfPageLink[] }[],
  host: LinkResolveHost,
  lines: string[] = [],
): ReturnType<typeof resolvePdfLinkTargets> {
  return resolvePdfLinkTargets(pages, host, { reportInternalError: (detail) => lines.push(detail) });
}

/**
 * Creates a page whose links have the hrefs, in order.
 *
 * @param hrefs The hrefs.
 */
function createPage(hrefs: readonly string[]): { readonly links: readonly PdfPageLink[] } {
  return { links: hrefs.map((href) => ({ x: 0, y: 0, width: 1, height: 1, target: { kind: 'href', href } })) };
}

describe('deciding where each href leads', () => {
  it('opens web and mail links as written, whatever the case of the scheme', async () => {
    const hrefs = ['https://example.com/a', 'HTTP://example.com/b', 'mailto:a@example.com'];

    const targets = await resolveTargets([createPage(hrefs)], createHost());

    expect(hrefs.map((href) => targets.get(href))).toEqual([
      { kind: 'uri', uri: 'https://example.com/a' },
      { kind: 'uri', uri: 'HTTP://example.com/b' },
      { kind: 'uri', uri: 'mailto:a@example.com' },
    ]);
  });

  it('gives no target to other schemes, such as javascript, data and file', async () => {
    const hrefs = ['javascript:alert(1)', 'data:text/html,a', 'file:///etc/passwd'];

    const targets = await resolveTargets([createPage(hrefs)], createHost());

    expect(targets.size).toBe(0);
  });

  it('resolves a relative and a root-relative href to the file the editor opens, keeping the query and fragment as written', async () => {
    const targets = await resolveTargets([createPage(['a.html?v=1#goal', '/index.html'])], createHost());

    expect([targets.get('a.html?v=1#goal'), targets.get('/index.html')]).toEqual([
      { kind: 'file', targetPath: '/ws/docs/a.html', suffix: '?v=1#goal' },
      { kind: 'file', targetPath: '/ws/index.html', suffix: '' },
    ]);
  });

  it('leaves a missing file unlinked without recording anything', async () => {
    const lines: string[] = [];

    const targets = await resolveTargets(
      [createPage(['missing.html'])],
      createHost([], () => Promise.resolve({ kind: 'notFound' })),
      lines,
    );

    expect([targets.size, lines]).toEqual([0, []]);
  });

  it('leaves a file that could not be checked unlinked and records one line with the cause', async () => {
    const lines: string[] = [];

    const targets = await resolveTargets(
      [createPage(['locked.html'])],
      createHost([], () => Promise.resolve({ kind: 'openFailed', cause: 'NoPermissions' })),
      lines,
    );

    expect([targets.size, lines.length, lines[0]]).toEqual([
      0,
      1,
      expect.stringMatching(/openFailed.*locked\.html.*NoPermissions/u),
    ]);
  });

  it('leaves the link unlinked and records one line when a port throws', async () => {
    const lines: string[] = [];

    const targets = await resolveTargets(
      [createPage(['a.html'])],
      createHost([], () => Promise.reject(new Error('the provider is gone'))),
      lines,
    );

    expect([targets.size, lines.length, lines[0]]).toEqual([
      0,
      1,
      expect.stringMatching(/unexpectedError.*a\.html.*the provider is gone/u),
    ]);
  });

  it('looks each href up once, even when its link covers several lines on several pages', async () => {
    const checked: string[] = [];

    await resolveTargets([createPage(['a.html', 'a.html']), createPage(['a.html'])], createHost(checked));

    expect(checked).toEqual(['/ws/docs/a.html']);
  });
});

describe('the path from the folder of the PDF to a file', () => {
  it('names a file in the same folder with ./', () => {
    expect(toRelativeLinkReference(savedAt('/ws/report.pdf'), FILE_DOCUMENT, '/ws/index.html', '')).toBe('./index.html');
  });

  it('climbs out of the folder of the PDF with ../', () => {
    expect(toRelativeLinkReference(savedAt('/ws/out/a.pdf'), FILE_DOCUMENT, '/ws/index.html', '')).toBe('../index.html');
  });

  it.each([
    ['a name with two dots', '/ws/a.b.html', './a.b.html'],
    ['a folder name with dots', '/ws/v1.2.3/x.html', './v1.2.3/x.html'],
  ])('starts %s with ./, which Chrome would otherwise take for a host name', (_name, targetPath, expected) => {
    expect(toRelativeLinkReference(savedAt('/ws/report.pdf'), FILE_DOCUMENT, targetPath, '')).toBe(expected);
  });

  it('climbs to the root when the paths share nothing else', () => {
    expect(toRelativeLinkReference(savedAt('/tmp/a.pdf'), FILE_DOCUMENT, '/ws/docs/index.html', ''))
      .toBe('../ws/docs/index.html');
  });

  it('counts a folder whose name holds a backslash as one folder, as the reader of the PDF does', () => {
    expect(toRelativeLinkReference(savedAt('/home/u/a\\b/out.pdf'), FILE_DOCUMENT, '/home/u/docs/x.html', ''))
      .toBe('../docs/x.html');
  });

  it('goes down from a PDF saved at the root', () => {
    expect(toRelativeLinkReference(savedAt('/a.pdf'), FILE_DOCUMENT, '/ws/index.html', '')).toBe('./ws/index.html');
  });

  it('appends the query and the fragment of the href as written', () => {
    expect(toRelativeLinkReference(savedAt('/ws/report.pdf'), FILE_DOCUMENT, '/ws/plan.html', '?v=1#goal'))
      .toBe('./plan.html?v=1#goal');
  });

  it('percent-encodes a question mark, a number sign, a percent sign, a space and Japanese in names', () => {
    expect(toRelativeLinkReference(savedAt('/ws/report.pdf'), FILE_DOCUMENT, '/ws/設計 a?b#c%d.html', ''))
      .toBe('./%E8%A8%AD%E8%A8%88%20a%3Fb%23c%25d.html');
  });

  it('takes drive letters that differ only in case for the same drive', () => {
    expect(toRelativeLinkReference(savedAt('/C:/out/a.pdf'), FILE_DOCUMENT, '/c:/ws/index.html', ''))
      .toBe('../ws/index.html');
  });

  it.each([
    ['another drive', savedAt('/d:/out/a.pdf'), '/c:/ws/index.html'],
    ['another authority', { scheme: 'file', authority: 'server', path: '/ws/a.pdf' }, '/ws/index.html'],
    ['another scheme', { scheme: 'vscode-remote', authority: '', path: '/ws/a.pdf' }, '/ws/index.html'],
  ])('gives no path to a PDF saved on %s', (_name, pdf, targetPath) => {
    expect(toRelativeLinkReference(pdf, FILE_DOCUMENT, targetPath, '')).toBeUndefined();
  });
});
