import type { InternalErrorSink } from '../diagnostics/error-reporter';
import {
  BACKUP_CONTENT_VERSION,
  decodeBackupContent,
  encodeBackupContent,
} from './backup-content';
import type { BackupContent } from './backup-content';

// TextEncoder and TextDecoder are globals in both extension hosts, but this layer has no DOM types.
declare const TextEncoder: { new (): { encode(input: string): Uint8Array } };
declare const TextDecoder: {
  new (label: string, options: { fatal: boolean }): { decode(input: Uint8Array): string };
};

/**
 * The backup file host.
 *
 * URIs are passed as strings. This layer can use neither Node.js path operations nor file APIs, so the wiring side
 * binds the workspace.fs implementation, which also works in the web extension host.
 */
export interface BackupFileHost {
  /**
   * Creates a child URI.
   *
   * @param parentUri The parent URI.
   * @param name The child's name.
   */
  joinPath(parentUri: string, name: string): string;

  /** Creates a directory, creating missing parents as well. */
  createDirectory(uri: string): Promise<void>;

  /** Whether anything exists at the URI. */
  exists(uri: string): Promise<boolean>;

  writeFile(uri: string, bytes: Uint8Array): Promise<void>;

  readFile(uri: string): Promise<Uint8Array>;

  /** Returns the names directly under the directory. */
  readDirectory(uri: string): Promise<readonly string[]>;

  /** Deletes the entry together with its contents. */
  delete(uri: string): Promise<void>;
}

/** The purpose of a backup. Included in the name so that someone looking at the storage can tell which path wrote it. */
export type BackupPurpose = 'hotExit' | 'protection';

// The maximum number of retries on a name collision. A timestamp and a one-time token practically never collide, but
// this keeps a faulty file host that always answers "exists" from looping forever.
const CREATE_ATTEMPTS = 3;

const GENERATION_PATTERN = /^(\d+)\.(json|done)$/;

/** State per backup location. */
interface LocationState {
  /** The tail used to run creates, writes, and deletes on this location one at a time in arrival order. */
  tail: Promise<void>;
  /** The next generation number. If not yet decided, the first write derives it from the existing generations. */
  nextGeneration: number | undefined;
  /** A flag set when deletion is requested. Writes after it is set are rejected. */
  deleted: boolean;
}

/**
 * Writes, reads, and deletes backup generations.
 *
 * A rewrite never overwrites an existing file; it writes a new generation, places the completion marker, and then
 * collects old generations. If the extension host exits in the middle of an overwrite, even the content written
 * just before would be lost.
 */
export class BackupStore {
  private readonly locations = new Map<string, LocationState>();

  /**
   * @param host The backup file host.
   * @param errorSink Where collection failures are recorded.
   * @param createToken A function that creates a one-time value to avoid name collisions.
   * @param now A function that returns the timestamp included in the name.
   */
  constructor(
    private readonly host: BackupFileHost,
    private readonly errorSink: InternalErrorSink,
    private readonly createToken: () => string,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Creates an unused backup directory under the parent.
   *
   * An existing location is never reused. Overwriting a previous backup that has not been restored yet would lose
   * its content.
   *
   * @param parentUri The parent directory URI.
   * @param purpose The purpose of the backup.
   * @returns The URI of the created backup directory.
   */
  async create(parentUri: string, purpose: BackupPurpose): Promise<string> {
    await this.host.createDirectory(parentUri);

    for (let attempt = 1; ; attempt += 1) {
      const name = `${purpose}-${new Date(this.now()).toISOString().replace(/[:.]/g, '-')}-${this.createToken()}`;
      const uri = this.host.joinPath(parentUri, name);
      if (await this.host.exists(uri)) {
        if (attempt >= CREATE_ATTEMPTS) {
          throw new Error(`Could not allocate an unused backup location: ${parentUri}`);
        }
        continue;
      }
      await this.run(uri, () => this.host.createDirectory(uri));
      this.stateOf(uri).nextGeneration = 1;
      return uri;
    }
  }

  /**
   * Writes a new generation, reads it back to verify it, and then publishes it as complete.
   *
   * The completion marker is written after the content. Only generations with a completion marker are read, so the
   * previous complete generation survives no matter when the process exits.
   *
   * @param backupUri The backup directory URI.
   * @param content The backup content to write.
   * @returns The content of the published generation.
   */
  writeGeneration(backupUri: string, content: BackupContent): Promise<BackupContent> {
    return this.run(backupUri, async () => {
      const state = this.stateOf(backupUri);
      if (state.deleted) {
        throw new Error(`Rejected a write to a backup whose deletion was requested: ${backupUri}`);
      }

      const generation = state.nextGeneration ?? (await this.findLatestGeneration(backupUri)) + 1;
      // Never reuse the number of a failed generation. A partially written file left behind would get different
      // content layered on the same name.
      state.nextGeneration = generation + 1;

      const bytes = encodeBackupContent(content);
      const contentUri = this.host.joinPath(backupUri, `${generation}.json`);
      await this.host.writeFile(contentUri, bytes);
      if (!isSameBytes(await this.host.readFile(contentUri), bytes)) {
        throw new Error(`The read-back of the backup generation does not match what was written: ${contentUri}`);
      }

      const marker = buildCompletionMarker(generation, bytes.length);
      const markerUri = this.host.joinPath(backupUri, `${generation}.done`);
      await this.host.writeFile(markerUri, new TextEncoder().encode(marker));
      if (decodeText(await this.host.readFile(markerUri)) !== marker) {
        throw new Error(`The read-back of the completion marker does not match what was written: ${markerUri}`);
      }

      await this.pruneGenerations(backupUri, generation);
      return content;
    });
  }

  /**
   * Reads the latest generation whose completion marker matches its content.
   *
   * @param backupUri The backup directory URI.
   * @param documentUri The canonical form of the target document's URI. Backups of other documents are not read.
   * @returns The latest valid backup content, or `undefined` if there is none.
   */
  readLatest(backupUri: string, documentUri: string): Promise<BackupContent | undefined> {
    return this.run(backupUri, async () => {
      const names = new Set(await this.host.readDirectory(backupUri));
      const generations = listGenerations(names, 'json').sort((left, right) => right - left);

      for (const generation of generations) {
        // A generation without a completion marker stopped in the middle of its write, so it is not used.
        if (!names.has(`${generation}.done`)) {
          continue;
        }
        const content = await this.readGeneration(backupUri, generation);
        if (content === undefined || content.documentUri !== documentUri) {
          continue;
        }
        return content;
      }
      return undefined;
    });
  }

  /**
   * Deletes a backup.
   *
   * The deletion flag is set before waiting. Accepting the next write while waiting for a running write would
   * recreate the deleted directory.
   *
   * @param backupUri The backup directory URI.
   */
  delete(backupUri: string): Promise<void> {
    this.stateOf(backupUri).deleted = true;
    return this.run(backupUri, () => this.host.delete(backupUri));
  }

  /**
   * Shares the completeness check between reading and collection, so a partially written completion marker alone
   * never causes an old generation to be deleted.
   *
   * @param backupUri The backup directory URI.
   * @param generation A generation number whose content and completion marker were listed.
   */
  private async readGeneration(backupUri: string, generation: number): Promise<BackupContent | undefined> {
    const bytes = await this.host.readFile(this.host.joinPath(backupUri, `${generation}.json`));
    const marker = decodeText(await this.host.readFile(this.host.joinPath(backupUri, `${generation}.done`)));
    if (marker !== buildCompletionMarker(generation, bytes.length)) {
      return undefined;
    }
    return decodeBackupContent(bytes);
  }

  /**
   * Keeps the published generation and the previous complete generation, and collects anything older.
   *
   * The previous complete generation is kept as a fallback in case the published one cannot be read. A collection
   * failure loses no content, so it is only recorded.
   *
   * @param backupUri The backup directory URI.
   * @param publishedGeneration The generation number read back through its completion marker.
   */
  private async pruneGenerations(backupUri: string, publishedGeneration: number): Promise<void> {
    let names: Set<string>;
    try {
      names = new Set(await this.host.readDirectory(backupUri));
    } catch (error) {
      this.errorSink.reportInternalError(`Could not list backup generations ${backupUri}: ${String(error)}`);
      return;
    }

    const candidates = listGenerations(names, 'json')
      .filter((generation) => generation < publishedGeneration && names.has(`${generation}.done`))
      .sort((left, right) => right - left);
    let previous: number | undefined;
    try {
      for (const generation of candidates) {
        if (await this.readGeneration(backupUri, generation) !== undefined) {
          previous = generation;
          break;
        }
      }
    } catch (error) {
      // While the generation to keep cannot be verified, existing backups are not collected.
      this.errorSink.reportInternalError(`Could not verify the previous complete generation ${backupUri}: ${String(error)}`);
      return;
    }

    for (const name of names) {
      const generation = parseGeneration(name);
      if (generation === undefined || generation >= publishedGeneration || generation === previous) {
        continue;
      }
      try {
        await this.host.delete(this.host.joinPath(backupUri, name));
      } catch (error) {
        this.errorSink.reportInternalError(`Could not delete old backup generation ${name} ${backupUri}: ${String(error)}`);
      }
    }
  }

  /**
   * Returns the newest number among the existing generations.
   *
   * @param backupUri The backup directory URI.
   * @returns The latest generation number, or 0 if there is none.
   */
  private async findLatestGeneration(backupUri: string): Promise<number> {
    const generations = listGenerations(new Set(await this.host.readDirectory(backupUri)), undefined);
    return generations.length === 0 ? 0 : Math.max(...generations);
  }

  /**
   * Runs operations on the same location one at a time in arrival order.
   *
   * @param uri The backup directory URI.
   * @param operation The operation to run.
   */
  private run<T>(uri: string, operation: () => Promise<T>): Promise<T> {
    const state = this.stateOf(uri);
    const result = state.tail.then(operation);
    state.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private stateOf(uri: string): LocationState {
    let state = this.locations.get(uri);
    if (state === undefined) {
      state = { tail: Promise.resolve(), nextGeneration: undefined, deleted: false };
      this.locations.set(uri, state);
    }
    return state;
  }
}

/**
 * Builds the content of a completion marker.
 *
 * It carries the format version, generation number, and byte length, so that another generation's marker is not
 * mistaken for this one and truncated content is not read as complete. The match includes the trailing newline,
 * which also rejects a partially written marker.
 *
 * @param generation The generation number.
 * @param byteLength The UTF-8 byte length of the content.
 */
function buildCompletionMarker(generation: number, byteLength: number): string {
  return `${BACKUP_CONTENT_VERSION} ${generation} ${byteLength}\n`;
}

/**
 * Reads a generation number from a name.
 *
 * @param name A name directly under the directory.
 */
function parseGeneration(name: string): number | undefined {
  const match = GENERATION_PATTERN.exec(name);
  return match === null ? undefined : Number(match[1]);
}

/**
 * Collects generation numbers from a set of names.
 *
 * @param names The names directly under the directory.
 * @param extension The extension to collect. `undefined` collects both.
 */
function listGenerations(names: ReadonlySet<string>, extension: 'json' | 'done' | undefined): number[] {
  const generations = new Set<number>();
  for (const name of names) {
    const match = GENERATION_PATTERN.exec(name);
    if (match !== null && (extension === undefined || match[2] === extension)) {
      generations.add(Number(match[1]));
    }
  }
  return [...generations];
}

/**
 * Reads a completion marker as a string. Corrupted bytes become a value that never matches.
 *
 * @param bytes The bytes that were read.
 */
function decodeText(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function isSameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}
