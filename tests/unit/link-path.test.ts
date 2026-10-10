// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  countPathDepth,
  isPathWithinScope,
  readHrefSuffix,
  resolveScopeRootTargetPath,
  resolveTargetPath,
  toPathSegments,
} from '../../src/link/link-path';

// Base document. Its base directory is `/ws/docs`.
const DOCUMENT_PATH = '/ws/docs/a.html';

describe('target-path resolution', () => {
  it('resolves an href targeting a file below the base directory from that directory', () => {
    expect(resolveTargetPath('sub/b.html', DOCUMENT_PATH)).toBe('/ws/docs/sub/b.html');
  });

  it('resolves an href above the base directory to a path that remains above it', () => {
    expect(resolveTargetPath('../x/b.html', DOCUMENT_PATH)).toBe('/ws/x/b.html');
  });

  it('resolves using only the path portion without query or fragment', () => {
    expect(resolveTargetPath('a.html?q=1#sec', DOCUMENT_PATH)).toBe('/ws/docs/a.html');
  });

  it('resolves percent-encoded whitespace as part of a file name', () => {
    expect(resolveTargetPath('my%20file.html', DOCUMENT_PATH)).toBe('/ws/docs/my file.html');
  });

  it('resolves an href with leading and trailing whitespace or newlines to the same target path', () => {
    expect(resolveTargetPath('\n  sub/b.html \t', DOCUMENT_PATH))
      .toBe(resolveTargetPath('sub/b.html', DOCUMENT_PATH));
  });

  it('resolves a percent-encoded question mark as part of a file name', () => {
    expect(resolveTargetPath('a%3Fb.html', DOCUMENT_PATH)).toBe('/ws/docs/a?b.html');
  });

  it('resolves percent-encoded separators and parent traversals as separators and parent traversals', () => {
    expect([
      resolveTargetPath('%2e%2e%2fb.html', DOCUMENT_PATH),
      resolveTargetPath('x%5Cb.html', DOCUMENT_PATH),
    ]).toEqual(['/ws/b.html', '/ws/docs/x/b.html']);
  });

  it('resolves backslashes in a path as separators equivalent to slashes', () => {
    expect(resolveTargetPath('sub\\b.html', DOCUMENT_PATH)).toBe('/ws/docs/sub/b.html');
  });

  it('stops parent traversal at the root', () => {
    expect(resolveTargetPath('../../../../b.html', DOCUMENT_PATH)).toBe('/b.html');
  });

  it('returns a path without empty, current, or parent segments for hrefs ending in a separator or parent traversal', () => {
    expect([
      resolveTargetPath('sub/', DOCUMENT_PATH),
      resolveTargetPath('sub/..', DOCUMENT_PATH),
      resolveTargetPath('./', DOCUMENT_PATH),
    ]).toEqual(['/ws/docs/sub', '/ws/docs', '/ws/docs']);
  });

  it('returns unresolvable without throwing for an href that cannot be decoded', () => {
    expect(resolveTargetPath('%zz.html', DOCUMENT_PATH)).toBeUndefined();
  });

  it('returns unresolvable for an href that contains the NUL character after decoding', () => {
    expect(resolveTargetPath('a%00.html', DOCUMENT_PATH)).toBeUndefined();
  });

  it('also returns unresolvable for an href that contains the NUL character before decoding', () => {
    expect(resolveTargetPath('a\u0000.html', DOCUMENT_PATH)).toBeUndefined();
  });

  it('resolves an href with the NUL character only in its query to the path without the query', () => {
    expect(resolveTargetPath('a.html?%00', DOCUMENT_PATH)).toBe('/ws/docs/a.html');
  });

  it('decodes a double-encoded NUL character only once, yielding a path whose name contains the three characters `%00`', () => {
    expect(resolveTargetPath('a%2500.html', DOCUMENT_PATH)).toBe('/ws/docs/a%00.html');
  });
});

describe('scope-root target-path resolution', () => {
  it('resolves an href against the scope root at the given depth, not the base directory', () => {
    expect(resolveScopeRootTargetPath('docs\\b.html', DOCUMENT_PATH, 1)).toBe('/ws/docs/b.html');
  });

  it('resolves against the base directory when the scope root is the base directory itself', () => {
    expect(resolveScopeRootTargetPath('b.html', DOCUMENT_PATH, 2)).toBe('/ws/docs/b.html');
  });

  it('returns unresolvable for an href that cannot be decoded', () => {
    expect(resolveScopeRootTargetPath('%E0%A4%A.html', DOCUMENT_PATH, 1)).toBeUndefined();
  });

  it('resolves a root-relative href against the scope root', () => {
    expect(resolveScopeRootTargetPath('/abs-root.html', DOCUMENT_PATH, 1)).toBe('/ws/abs-root.html');
  });
});

describe('path-segment extraction', () => {
  it('splits at slashes and backslashes, removes empty and current segments, and keeps parent traversals', () => {
    expect(toPathSegments('/ws//docs/./sub\\..\\b.html'))
      .toEqual(['ws', 'docs', 'sub', '..', 'b.html']);
  });
});

describe('scope check', () => {
  // Depth of the scope root `/ws`. The base document `/ws/docs/a.html` is beneath it.
  const WORKSPACE_DEPTH = 1;
  // Depth when the scope root is the base directory `/ws/docs`.
  const DIRECTORY_DEPTH = 2;

  it('treats a target that matches the document path through the scope depth and continues past it as within scope', () => {
    expect(isPathWithinScope('/ws/x.html', DOCUMENT_PATH, WORKSPACE_DEPTH)).toBe(true);
  });

  it('treats a target in a subdirectory below the scope root as within scope', () => {
    expect(isPathWithinScope('/ws/docs/sub/x.html', DOCUMENT_PATH, WORKSPACE_DEPTH)).toBe(true);
  });

  it('treats a target above the scope root as outside scope', () => {
    expect(isPathWithinScope('/x.html', DOCUMENT_PATH, WORKSPACE_DEPTH)).toBe(false);
  });

  it('treats a target in another directory whose name only starts with the scope root name as outside scope', () => {
    // Scope root `/ws/doc`, document `/ws/doc/a.html`. The target's `docs` is not beneath `doc`.
    expect(isPathWithinScope('/ws/docs/a.html', '/ws/doc/a.html', DIRECTORY_DEPTH)).toBe(false);
  });

  it('treats a target spelled differently only in letter case as outside scope', () => {
    expect(isPathWithinScope('/ws/Docs/a.html', DOCUMENT_PATH, DIRECTORY_DEPTH)).toBe(false);
  });

  it('treats a target spelled like the document as within scope even when the scope root is spelled differently', () => {
    // The scope root is `/c:/ws` (depth 2) while the document is `/C:/ws/docs/a.html`. The comparison uses the
    // document's spelling.
    expect(isPathWithinScope('/C:/ws/a.html', '/C:/ws/docs/a.html', DIRECTORY_DEPTH)).toBe(true);
  });

  it('treats a target whose path equals the scope root itself as within scope', () => {
    expect(isPathWithinScope('/ws/docs', DOCUMENT_PATH, DIRECTORY_DEPTH)).toBe(true);
  });

  it('treats a target shallower than the scope root as outside scope', () => {
    // Points to the parent of the scope root `/ws/docs`.
    expect(isPathWithinScope('/ws', DOCUMENT_PATH, DIRECTORY_DEPTH)).toBe(false);
  });

  it('treats a target in a sibling folder that shares the scope root parent as outside scope', () => {
    // Scope root `/ws/a`, document `/ws/a/doc.html`.
    expect(isPathWithinScope('/ws/b/x.html', '/ws/a/doc.html', DIRECTORY_DEPTH)).toBe(false);
  });
});

describe('path-depth counting', () => {
  it('counts the same depth regardless of trailing or consecutive separators, with depth 0 for the root', () => {
    expect([
      countPathDepth('/ws/docs'),
      countPathDepth('/ws/docs/'),
      countPathDepth('/ws//docs'),
      countPathDepth('/'),
    ]).toEqual([2, 2, 2, 0]);
  });
});

describe('the query and fragment of an href', () => {
  it('returns everything from the first question mark or number sign as written', () => {
    expect(readHrefSuffix(' a.html?q=1#sec ')).toBe('?q=1#sec');
  });

  it('returns an empty string for an href with neither', () => {
    expect(readHrefSuffix('docs/a.html')).toBe('');
  });
});
