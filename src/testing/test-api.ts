import type * as vscode from 'vscode';

/**
 * The interface `activate` returns for integration tests. Tests cannot reach the
 * Webview's DOM, so making a WYSIWYG document dirty requires a hook on the
 * extension side.
 */
export interface AhveTestApi {
  /**
   * Makes the open WYSIWYG document for `uri` dirty in exactly the same way an edit
   * in its Webview would. Returns false when no WYSIWYG editor holds that uri.
   */
  fireWysiwygEdit(uri: vscode.Uri): boolean;
  setWysiwygTestHtml(uri: vscode.Uri, html: string): boolean;
  getWysiwygTestHtml(uri: vscode.Uri): Promise<string | null>;
  requestWysiwygTestSave(uri: vscode.Uri): boolean;
  openWysiwygTestRelativeFile(uri: vscode.Uri, href: string): Promise<boolean>;
  openWysiwygTestRelativeFileViaWebview(uri: vscode.Uri, href: string): boolean;
}

/**
 * The provider of the test hooks. `AhveEditorProvider` implements it, but only these
 * six members are required here — not depending on the whole production class is
 * what makes this assembly unit-testable with a fake implementation.
 */
export interface WysiwygTestTarget {
  fireTestEdit(uri: vscode.Uri): boolean;
  setTestViewHtml(uri: vscode.Uri, html: string): boolean;
  getTestViewHtml(uri: vscode.Uri): Promise<string | null>;
  requestTestViewSave(uri: vscode.Uri): boolean;
  openTestRelativeFile(uri: vscode.Uri, href: string): Promise<boolean>;
  openTestRelativeFileViaWebview(uri: vscode.Uri, href: string): boolean;
}

/**
 * Translates the extension-side hooks into the names the integration tests use.
 *
 * This file exists to keep test-only types and assembly out of the production entry
 * point (`activate`). The integration tests depend on the shape of `activate`'s
 * return value, so do not change the method names or signatures of `AhveTestApi`.
 */
export function createTestApi(target: WysiwygTestTarget): AhveTestApi {
  return {
    fireWysiwygEdit: (uri) => target.fireTestEdit(uri),
    setWysiwygTestHtml: (uri, html) => target.setTestViewHtml(uri, html),
    getWysiwygTestHtml: (uri) => target.getTestViewHtml(uri),
    requestWysiwygTestSave: (uri) => target.requestTestViewSave(uri),
    openWysiwygTestRelativeFile: (uri, href) => target.openTestRelativeFile(uri, href),
    openWysiwygTestRelativeFileViaWebview: (uri, href) =>
      target.openTestRelativeFileViaWebview(uri, href),
  };
}
