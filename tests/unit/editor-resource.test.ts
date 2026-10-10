// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';

import {
  createEditorResource,
  isEditorResource,
  resolveEditorSource,
  resolveHtmlSource,
} from '../../src/editor/editor-resource';

interface UriComponents {
  readonly scheme: string;
  readonly authority: string;
  readonly path: string;
  readonly query: string;
  readonly fragment: string;
}

/** Inspects only value substitution on the Uri. Round trips through real VS Code URIs and tabs are inspected in integration. */
function uri(changes: Partial<UriComponents> = {}): vscode.Uri {
  const value: UriComponents = {
    scheme: 'file', authority: '', path: '/notes/a.html', query: '', fragment: '', ...changes,
  };
  // Pass a value with only the Uri components, `with`, and `toString` that the helper uses.
  return {
    ...value,
    with: (next: Partial<UriComponents>) => uri({ ...value, ...next }),
    toString: () => JSON.stringify(value),
  } as unknown as vscode.Uri;
}

describe('separating document and source file URIs', () => {
  it('makes a separate URI even for a source file with an empty query, and creates the same document URI from the same input', () => {
    const source = uri();
    const editor = createEditorResource(source);

    expect(isEditorResource(source)).toBe(false);
    expect(isEditorResource(editor)).toBe(true);
    expect(editor.toString()).not.toBe(source.toString());
    expect(createEditorResource(source).toString()).toBe(editor.toString());
    expect(resolveEditorSource(editor).toString()).toBe(source.toString());
  });

  it('restores a virtual file\'s authority, non-ASCII path, query, and fragment verbatim', () => {
    const source = uri({
      scheme: 'virtual', authority: 'workspace', path: '/\u65e5\u672c\u8a9e/a b.html',
      query: '\u7248=2&key=a%20b?"', fragment: '\u672c\u6587#1',
    });
    const editor = createEditorResource(source);

    expect([editor.scheme, editor.authority, editor.path, editor.fragment])
      .toEqual([source.scheme, source.authority, source.path, '']);
    expect(resolveEditorSource(editor).toString()).toBe(source.toString());
  });

  it('restores the new source file when Save As carries the query over and changes the path', () => {
    const source = uri({ scheme: 'virtual', authority: 'workspace', query: 'rev=1', fragment: 'p' });
    const editor = createEditorResource(source);
    const destination = editor.with({ path: '/other/destination.html' });

    expect(resolveEditorSource(destination).toString())
      .toBe(source.with({ path: '/other/destination.html' }).toString());
  });

  it('does not double-wrap a value that is already an editor resource URI', () => {
    expect(() => createEditorResource(createEditorResource(uri()))).toThrow();
    const nested = uri({ query: 'ahve-editor=' + encodeURIComponent(JSON.stringify({
      query: createEditorResource(uri()).query, fragment: '',
    })) });
    expect(() => resolveEditorSource(nested)).toThrow();
  });

  it.each([
    ['no identifier', ''], ['invalid encoding', 'ahve-editor=%ZZ'], ['not JSON', 'ahve-editor=broken'],
    ['array', 'ahve-editor=' + encodeURIComponent('[]')],
    ['null', 'ahve-editor=null'], ['number', 'ahve-editor=1'],
    ['missing field', 'ahve-editor=' + encodeURIComponent('{"query":""}')],
    ['wrong type', 'ahve-editor=' + encodeURIComponent('{"query":1,"fragment":""}')],
    ['extra property', 'ahve-editor=' + encodeURIComponent('{"query":"","fragment":"","extra":1}')],
    ['non-canonical form', 'ahve-editor=' + encodeURIComponent('{ "query": "", "fragment": "" }')],
  ])('rejects invalid restore information: %s', (_label, query) => {
    expect(() => resolveEditorSource(uri({ query }))).toThrow();
  });

  it('rejects an editor resource URI with a fragment added beyond the restore information', () => {
    expect(() => resolveEditorSource(createEditorResource(uri()).with({ fragment: 'extra' }))).toThrow();
  });
});

describe('resolving the source URI to open', () => {
  it('returns the original source URI when given an editor resource URI', () => {
    const source = uri({ query: 'rev=1', fragment: 'p' });

    expect(resolveHtmlSource(createEditorResource(source)).toString()).toBe(source.toString());
  });

  it('accepts a source URI with an uppercase .HTML extension as is', () => {
    const source = uri({ path: '/notes/A.HTML' });

    expect(resolveHtmlSource(source).toString()).toBe(source.toString());
  });

  it.each([
    ['.htm', { path: '/notes/a.htm' }],
    ['no extension', { path: '/notes/a' }],
    ['.html only in the query', { path: '/notes/a.txt', query: 'name=a.html' }],
  ])('rejects a URI that does not end with .html: %s', (_label, changes) => {
    expect(() => resolveHtmlSource(uri(changes))).toThrow();
  });

  it('rejects an editor resource URI with broken restore information', () => {
    const broken = uri({ query: 'ahve-editor=' + encodeURIComponent('{"query":1,"fragment":""}') });

    expect(() => resolveHtmlSource(broken)).toThrow();
  });
});
