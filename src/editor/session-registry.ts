import type * as vscode from 'vscode';
import type { AhveDocument } from './AhveDocument';

/**
 * The single place that tracks where the open WYSIWYG sessions are.
 */
export class AhveSessionRegistry {
  private readonly documents = new Map<string, AhveDocument>();

  // Track the most recently active WYSIWYG panel so that command-palette commands
  // (e.g. copy as HTML) can identify their target.
  private activePanel: vscode.WebviewPanel | null = null;

  public add(document: AhveDocument): void {
    this.documents.set(document.uri.toString(), document);
  }

  /** Removes the given document only if it is still the registered one. */
  public remove(document: AhveDocument): void {
    const key = document.uri.toString();
    if (this.documents.get(key) === document) {
      this.documents.delete(key);
    }
  }

  /**
   * The open document for `uri`. Falls back to matching by fsPath: VSCode may
   * normalize a uri before it reaches openCustomDocument (e.g. the case of a
   * Windows drive letter).
   */
  public find(uri: vscode.Uri): AhveDocument | undefined {
    return (
      this.documents.get(uri.toString()) ??
      [...this.documents.values()].find((document) => document.uri.fsPath === uri.fsPath)
    );
  }

  public getActivePanel(): vscode.WebviewPanel | null {
    return this.activePanel;
  }

  public setActivePanel(panel: vscode.WebviewPanel): void {
    this.activePanel = panel;
  }

  /** Clears the active panel only if `panel` is the current one. */
  public clearActivePanel(panel: vscode.WebviewPanel): void {
    if (this.activePanel === panel) {
      this.activePanel = null;
    }
  }

  /** The document that hosts the active panel. */
  public getActiveDocument(): AhveDocument | undefined {
    const panel = this.activePanel;
    if (!panel) return undefined;
    return [...this.documents.values()].find((candidate) => candidate.panel === panel);
  }
}
