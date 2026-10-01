import * as vscode from 'vscode';

/**
 * One table entry: the type a query returns, or a mark that makes the query fail with no permissions or because an
 * intermediate segment is a file.
 */
export type LinkTargetEntry = vscode.FileType | 'noPermissions' | 'notADirectory';

/**
 * A custom-scheme file system that answers queries with the existence and type from the table the test passed at
 * creation.
 *
 * It exists so that VS Code queries unknown entries, dangling symbolic links, and query failures, none of which can be
 * created on disk, through the same path as in a real environment.
 */
export class LinkTargetFileSystem implements vscode.FileSystemProvider {
  private readonly changes = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changes.event;
  private readonly modifiedAt = Date.now();
  private readonly bytes: Uint8Array;
  private readonly entries: ReadonlyMap<string, LinkTargetEntry>;

  /**
   * @param documentPath The base document path. Queries for it answer as a file.
   * @param text The content of the base document and of entries whose type includes File.
   * @param entries The type or failure for each path. Not changed after creation.
   */
  constructor(documentPath: string, text: string, entries: ReadonlyMap<string, LinkTargetEntry>) {
    this.bytes = new TextEncoder().encode(text);
    this.entries = new Map([...entries, [documentPath, vscode.FileType.File]]);
  }

  watch(): vscode.Disposable {
    return { dispose: (): void => undefined };
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    const entry = this.entries.get(uri.path);
    if (entry === undefined) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    if (entry === 'noPermissions') {
      throw vscode.FileSystemError.NoPermissions(uri);
    }
    if (entry === 'notADirectory') {
      throw vscode.FileSystemError.FileNotADirectory(uri);
    }
    return { type: entry, ctime: 0, mtime: this.modifiedAt, size: this.bytes.length };
  }

  readDirectory(): [string, vscode.FileType][] {
    return [];
  }

  readFile(uri: vscode.Uri): Uint8Array {
    // Dangling symbolic links and unknown entries have no readable content.
    if ((this.stat(uri).type & vscode.FileType.File) === 0) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    return this.bytes.slice();
  }

  writeFile(): void {
    throw vscode.FileSystemError.NoPermissions();
  }

  createDirectory(): void {
    throw vscode.FileSystemError.NoPermissions();
  }

  delete(): void {
    throw vscode.FileSystemError.NoPermissions();
  }

  rename(): void {
    throw vscode.FileSystemError.NoPermissions();
  }

  dispose(): void {
    this.changes.dispose();
  }
}
