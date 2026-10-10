import type { InternalErrorSink } from '../diagnostics/error-reporter';
import type { BackupFileHost } from './backup-store';

// TextEncoder and TextDecoder are globals in both extension hosts, but this layer has no DOM types.
// The web extension host cannot resolve node:util, so only the shapes in use are declared.
declare const TextEncoder: { new (): { encode(input: string): Uint8Array } };
declare const TextDecoder: {
  new (label: string, options: { fatal: boolean }): { decode(input: Uint8Array): string };
};

// The format version of a record. Written so that a reader never treats an unknown format as content.
const RESTORE_RECORD_VERSION = 1;

// The record name prefixes. A latest protection reference is named from the source URI and a discard record
// from the backup location, so the kinds are kept apart to prevent name collisions under the same parent.
// Also used to list discard records.
const LATEST_PREFIX = 'latest-';
const DISCARD_PREFIX = 'discard-';

// The record file extension. Appended when building a URI from a record name and stripped when listing.
const RECORD_EXTENSION = '.json';

/** A single discard record. */
export interface RestoreDiscardRecord {
  /** The source URI the backup was for. */
  readonly documentUri: string;
  /** The backup location whose discard was confirmed. */
  readonly backupUri: string;
}

/** The contents of a record file. */
interface RestoreRecordFile {
  readonly version: typeof RESTORE_RECORD_VERSION;
  readonly documentUri: string;
  readonly backupUri: string;
}

/**
 * A store that persists latest protection references and discard records.
 *
 * Kept in the same storage as the backups themselves. Keeping them elsewhere would allow a state where the
 * backup remains but only the reference is gone, and the next open could not decide which one to trust.
 */
export class RestoreRecordStore {
  // The run queue for each record name. If reads and writes of the same name overlapped, the read-back right
  // after a write could read the result of another write.
  private readonly tails = new Map<string, Promise<void>>();

  /**
   * @param host The backup file host.
   * @param parentUri The URI of the parent directory that holds the records.
   * @param errorSink Where to record facts the user cannot act on.
   */
  constructor(
    private readonly host: BackupFileHost,
    private readonly parentUri: string,
    private readonly errorSink: InternalErrorSink,
  ) {}

  /**
   * Reads the reference to the latest protection backup of a source URI.
   *
   * @param documentUri The canonical form of the source URI.
   * @returns The referenced backup location, or `undefined` if there is no reference.
   */
  readLatestProtection(documentUri: string): Promise<string | undefined> {
    const name = latestName(documentUri);
    return this.run(name, async () => {
      const record = await this.readRecord(name);
      // The record name is a hash of the URI, so a record for another URI can have the same name. If the URI
      // inside differs, treat it as no reference so that a backup of another document is never selected.
      return record === undefined || record.documentUri !== documentUri ? undefined : record.backupUri;
    });
  }

  /**
   * Makes a verified protection backup the latest protection reference of a source URI.
   *
   * @param documentUri The canonical form of the source URI.
   * @param backupUri The backup location to reference from now on.
   * @returns The previously referenced location, or `undefined` if there was none.
   */
  updateLatestProtection(documentUri: string, backupUri: string): Promise<string | undefined> {
    const name = latestName(documentUri);
    return this.run(name, async () => {
      // This record is about to be overwritten, so being unable to read it is not a failure. Failing here
      // would let a single corrupt record fail the protection backup itself.
      let previous: string | undefined;
      try {
        const existing = await this.readRecord(name);
        previous = existing?.documentUri === documentUri ? existing.backupUri : undefined;
      } catch (error) {
        this.errorSink.reportInternalError(`Updated the latest protection reference without reading its previous value ${name}: ${String(error)}`);
      }

      const record: RestoreRecordFile = { version: RESTORE_RECORD_VERSION, documentUri, backupUri };
      await this.writeRecord(name, record);
      const readBack = await this.readRecord(name);
      if (readBack?.documentUri !== documentUri || readBack.backupUri !== backupUri) {
        throw new Error(`The read-back of the latest protection reference does not match what was written ${name}`);
      }
      return previous;
    });
  }

  /**
   * Releases the latest protection reference of a source URI.
   *
   * @param documentUri The canonical form of the source URI.
   * @param backupUri The referenced location to release. `undefined` releases without checking the reference.
   */
  releaseLatestProtection(documentUri: string, backupUri: string | undefined): Promise<void> {
    const name = latestName(documentUri);
    return this.run(name, async () => {
      if (backupUri !== undefined) {
        let current: RestoreRecordFile | undefined;
        try {
          current = await this.readRecord(name);
        } catch (error) {
          // Deleting without checking the reference could drop a reference to another backup created later.
          this.errorSink.reportInternalError(`Did not release the latest protection reference because it could not be read ${name}: ${String(error)}`);
          return;
        }
        if (current?.documentUri !== documentUri || current.backupUri !== backupUri) {
          return;
        }
      }
      await this.deleteRecord(name);
    });
  }

  /**
   * Persists the discard record of a backup location.
   *
   * @param documentUri The canonical form of the source URI.
   * @param backupUri The backup location to discard.
   */
  recordDiscard(documentUri: string, backupUri: string): Promise<void> {
    const name = discardName(backupUri);
    return this.run(name, async () => {
      const record: RestoreRecordFile = { version: RESTORE_RECORD_VERSION, documentUri, backupUri };
      await this.writeRecord(name, record);
      const readBack = await this.readRecord(name);
      if (readBack?.backupUri !== backupUri || readBack.documentUri !== documentUri) {
        throw new Error(`The read-back of the discard record does not match what was written ${name}`);
      }
    });
  }

  /**
   * Returns whether a backup location has a discard record.
   *
   * @param backupUri The backup location.
   * @returns `true` if a discard record exists.
   */
  isDiscarded(backupUri: string): Promise<boolean> {
    // The contents are not read. Treating a record whose contents cannot be read as "no discard record" would
    // restore a discarded backup again.
    return this.host.exists(this.uriOf(discardName(backupUri)));
  }

  /**
   * Returns every discard record that could be read.
   *
   * @returns The discard records, or an empty array if the records' parent does not exist.
   */
  async listDiscards(): Promise<readonly RestoreDiscardRecord[]> {
    if (!(await this.host.exists(this.parentUri))) {
      return [];
    }

    const names = (await this.host.readDirectory(this.parentUri))
      .filter((entry) => entry.startsWith(DISCARD_PREFIX) && entry.endsWith(RECORD_EXTENSION))
      .map((entry) => entry.slice(0, -RECORD_EXTENSION.length));
    const records: RestoreDiscardRecord[] = [];
    for (const name of names) {
      let record: RestoreRecordFile | undefined;
      try {
        record = await this.readRecord(name);
      } catch (error) {
        // Not deleted. Deleting an unreadable record would hide the fact that a remaining backup was discarded.
        this.errorSink.reportInternalError(`Excluded a discard record from redeletion because it could not be read ${name}: ${String(error)}`);
        continue;
      }
      if (record !== undefined) {
        records.push({ documentUri: record.documentUri, backupUri: record.backupUri });
      }
    }
    return records;
  }

  /**
   * Deletes the discard record of a backup whose disappearance was confirmed.
   *
   * @param backupUri The backup location.
   */
  clearDiscard(backupUri: string): Promise<void> {
    const name = discardName(backupUri);
    return this.run(name, () => this.deleteRecord(name));
  }

  /**
   * Writes a record.
   *
   * @param name The record name.
   * @param record The contents to write.
   */
  private async writeRecord(name: string, record: RestoreRecordFile): Promise<void> {
    await this.host.createDirectory(this.parentUri);
    await this.host.writeFile(this.uriOf(name), new TextEncoder().encode(JSON.stringify(record)));
  }

  /**
   * Reads a record.
   *
   * @param name The record name.
   * @returns The record contents, or `undefined` if there is no record. Throws if it is unreadable or malformed.
   */
  private async readRecord(name: string): Promise<RestoreRecordFile | undefined> {
    const uri = this.uriOf(name);
    if (!(await this.host.exists(uri))) {
      return undefined;
    }

    const bytes = await this.host.readFile(uri);
    let parsed: unknown;
    try {
      // Turning invalid bytes into replacement characters would return a corrupt record as a valid reference.
      parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch (error) {
      throw new Error(`Could not read the record ${name}: ${String(error)}`);
    }
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error(`The record is malformed ${name}`);
    }
    const version = readField(parsed, 'version');
    const documentUri = readField(parsed, 'documentUri');
    const backupUri = readField(parsed, 'backupUri');
    if (version !== RESTORE_RECORD_VERSION || typeof documentUri !== 'string' || typeof backupUri !== 'string') {
      throw new Error(`The record is malformed ${name}`);
    }
    return { version, documentUri, backupUri };
  }

  /**
   * Deletes a record and confirms that it is gone.
   *
   * @param name The record name.
   */
  private async deleteRecord(name: string): Promise<void> {
    const uri = this.uriOf(name);
    if (!(await this.host.exists(uri))) {
      return;
    }
    await this.host.delete(uri);
    if (await this.host.exists(uri)) {
      throw new Error(`The record remains after being deleted ${name}`);
    }
  }

  private uriOf(name: string): string {
    return this.host.joinPath(this.parentUri, `${name}${RECORD_EXTENSION}`);
  }

  /**
   * Runs operations on the same record name one at a time, in the order received.
   *
   * @param name The record name.
   * @param operation The operation to run.
   */
  private run<T>(name: string, operation: () => Promise<T>): Promise<T> {
    const tail = this.tails.get(name) ?? Promise.resolve();
    const result = tail.then(operation);
    this.tails.set(name, result.then(() => undefined, () => undefined));
    return result;
  }
}

/**
 * Builds the record name of a latest protection reference.
 *
 * @param documentUri The canonical form of the source URI.
 */
function latestName(documentUri: string): string {
  return `${LATEST_PREFIX}${hashName(documentUri)}`;
}

/**
 * Builds the record name of a discard record.
 *
 * @param backupUri The backup location.
 */
function discardName(backupUri: string): string {
  return `${DISCARD_PREFIX}${hashName(backupUri)}`;
}

/**
 * Builds the hexadecimal value used as a record name from a URI.
 *
 * A URI cannot be used as a name as is: it contains the scheme separator and path separators, and its length
 * can exceed the file name limit. 64-bit FNV-1a is used because it is short enough while collisions do not
 * occur in practice, and it can be written without external dependencies.
 *
 * @param value The string the name is built from.
 */
function hashName(value: string): string {
  const mask = 0xffffffffffffffffn;
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) {
    hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & mask;
  }
  return hash.toString(16).padStart(16, '0');
}

/**
 * Reads only an own property of a value parsed from JSON.
 *
 * @param value The value parsed from JSON.
 * @param field The property name to read.
 */
function readField(value: object, field: string): unknown {
  return Object.getOwnPropertyDescriptor(value, field)?.value;
}
