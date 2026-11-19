import * as vscode from 'vscode';

/** Pins, for tests, the order of file writes and change notifications to VS Code. */
export class DelayedFileSystem implements vscode.FileSystemProvider {
  private readonly changes = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changes.event;
  readonly writtenUris: string[] = [];
  /**
   * Whether every write is announced as a change, as a file watcher would announce it. Off by default, so that the test
   * decides when VS Code hears of a write.
   */
  notifyWrites = false;
  private modifiedAt = Date.now();
  private bytes: Uint8Array;
  private nextWrite: {
    readonly reached: () => void;
    readonly resumed: Promise<void>;
    readonly emptyWhileHeld: boolean;
  } | undefined;

  constructor(private readonly sourceUri: vscode.Uri, text: string) {
    this.bytes = new TextEncoder().encode(text);
  }

  readText(): string {
    return new TextDecoder().decode(this.bytes);
  }

  notifyWrittenFile(): void {
    this.changes.fire([{ type: vscode.FileChangeType.Changed, uri: this.sourceUri }]);
  }

  /**
   * Holds the next write until the test releases it, independently of file I/O and UI timing.
   *
   * @param options `emptyWhileHeld` makes the file read as empty while the write is held, as a real write does between
   *   truncating the file and writing its content.
   */
  pauseNextWrite(
    options: { readonly emptyWhileHeld?: boolean } = {},
  ): { readonly reached: Promise<void>; release(): void } {
    let markReached = (): void => undefined;
    const reached = new Promise<void>((resolve) => {
      markReached = resolve;
    });
    let release = (): void => undefined;
    const resumed = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.nextWrite = { reached: markReached, resumed, emptyWhileHeld: options.emptyWhileHeld === true };
    return { reached, release };
  }

  watch(): vscode.Disposable {
    return { dispose: (): void => undefined };
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    return {
      type: uri.path === this.sourceUri.path ? vscode.FileType.File : vscode.FileType.Directory,
      ctime: 0,
      mtime: this.modifiedAt,
      size: this.bytes.length,
    };
  }

  readDirectory(): [string, vscode.FileType][] {
    return [[this.sourceUri.path.slice(this.sourceUri.path.lastIndexOf('/') + 1), vscode.FileType.File]];
  }

  readFile(uri: vscode.Uri): Uint8Array {
    if (uri.path !== this.sourceUri.path) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    return this.bytes.slice();
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    if (uri.toString() !== this.sourceUri.toString()) {
      throw vscode.FileSystemError.NoPermissions('An editor resource URI must not be passed to file I/O.');
    }
    const pause = this.nextWrite;
    this.nextWrite = undefined;
    if (pause !== undefined) {
      if (pause.emptyWhileHeld) {
        this.bytes = new Uint8Array();
        this.modifiedAt = Math.max(this.modifiedAt + 1, Date.now());
      }
      pause.reached();
      await pause.resumed;
    }
    this.bytes = content.slice();
    this.modifiedAt = Math.max(this.modifiedAt + 1, Date.now());
    this.writtenUris.push(uri.toString());
    if (this.notifyWrites) {
      this.notifyWrittenFile();
    }
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
