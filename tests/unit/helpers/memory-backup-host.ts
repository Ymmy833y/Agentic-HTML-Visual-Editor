import type { BackupFileHost } from '../../../src/backup/backup-store';

/** An interceptor called before a write is accepted. The write is held until the returned Promise settles. */
export type WriteInterceptor = (uri: string, bytes: Uint8Array) => Promise<void> | undefined;

/** A backup file host that writes to memory, with handles to its contents and to swap interceptors. */
export interface MemoryBackupHost extends BackupFileHost {
  readonly files: Map<string, Uint8Array>;
  interceptWrite: WriteInterceptor;
  failDeleteOf: (uri: string) => boolean;
  /** Lists the names directly under the directory. */
  list(uri: string): string[];
}

/**
 * Creates a backup file host that writes to memory instead of a file system.
 *
 * An exit in the middle of a write is simulated by leaving truncated bytes in place and never settling the Promise.
 * In a real environment nothing after the exit of the extension host runs, so never settling is closer to reality.
 * The branches exist only to reproduce real-environment behavior.
 */
export function createMemoryBackupHost(): MemoryBackupHost {
  const files = new Map<string, Uint8Array>();
  const directories = new Set<string>();
  const isWithin = (path: string, uri: string): boolean => path === uri || path.startsWith(`${uri}/`);

  const host: MemoryBackupHost = {
    files,
    interceptWrite: () => undefined,
    failDeleteOf: () => false,
    list: (uri) => [...files.keys(), ...directories]
      .filter((path) => path.startsWith(`${uri}/`) && !path.slice(uri.length + 1).includes('/'))
      .map((path) => path.slice(uri.length + 1)),
    joinPath: (parentUri, name) => `${parentUri}/${name}`,
    createDirectory: (uri) => {
      directories.add(uri);
      return Promise.resolve();
    },
    exists: (uri) => Promise.resolve(files.has(uri) || directories.has(uri)),
    writeFile: async (uri, bytes) => {
      await host.interceptWrite(uri, bytes);
      files.set(uri, bytes);
    },
    readFile: (uri) => {
      const bytes = files.get(uri);
      return bytes === undefined ? Promise.reject(new Error(`missing ${uri}`)) : Promise.resolve(bytes);
    },
    readDirectory: (uri) => Promise.resolve(host.list(uri)),
    delete: (uri) => {
      if (host.failDeleteOf(uri)) {
        return Promise.reject(new Error(`could not delete ${uri}`));
      }
      for (const path of [...files.keys()].filter((key) => isWithin(key, uri))) {
        files.delete(path);
      }
      for (const path of [...directories].filter((key) => isWithin(key, uri))) {
        directories.delete(path);
      }
      return Promise.resolve();
    },
  };
  return host;
}
