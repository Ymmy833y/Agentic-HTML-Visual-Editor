// TextEncoder and TextDecoder are globals in both extension hosts, but this layer has no DOM types.
// The web extension host cannot resolve node:util, so only the shapes in use are declared.
declare const TextEncoder: { new (): { encode(input: string): Uint8Array } };
declare const TextDecoder: {
  new (label: string, options: { fatal: boolean }): { decode(input: Uint8Array): string };
};

/** The version of the backup storage format. Written so that a reader does not treat an unknown format as content. */
export const BACKUP_CONTENT_VERSION = 1;

/**
 * The content written to a backup.
 *
 * Merging on resume and on recovery needs the merge base, so it is kept paired with the full text.
 */
export interface BackupContent {
  readonly version: typeof BACKUP_CONTENT_VERSION;
  /** The canonical form of the target document's URI. Kept so that another document's backup is not mistaken for it. */
  readonly documentUri: string;
  /** The full document text (LF). */
  readonly fullText: string;
  /** The full text of the merge base (LF). */
  readonly mergeBase: string;
}

/** The current values read to assemble backup content. */
export interface BackupContentInput {
  readonly documentUri: string;
  /** The retained copy. `undefined` if none has been received yet. */
  readonly retainedCopy: string | undefined;
  /** The merge base. `undefined` if the sync base is not initialized. */
  readonly mergeBase: string | undefined;
}

/**
 * Assembles backup content from the current values.
 *
 * Does not wait even if a save or history application is running in the operation queue. A backup request does
 * not necessarily arrive at a time when it can wait for the queue to finish.
 *
 * @param input The target URI, retained copy, and merge base.
 * @param protection The old full text, passed only for a protection backup.
 * @returns The backup content, or `undefined` if the full text or merge base is missing.
 */
export function assembleBackupContent(
  input: BackupContentInput,
  protection?: { readonly staleText: string | undefined },
): BackupContent | undefined {
  // Filling a missing old full text of a protection backup with the retained copy would preserve what the failed
  // application left behind as if it were the correct old full text.
  const fullText = protection === undefined ? input.retainedCopy : protection.staleText;
  // An empty string is an obtained value and is distinguished from a missing one.
  if (fullText === undefined || input.mergeBase === undefined) {
    return undefined;
  }
  return {
    version: BACKUP_CONTENT_VERSION,
    documentUri: input.documentUri,
    fullText,
    mergeBase: input.mergeBase,
  };
}

/**
 * Encodes backup content as UTF-8 JSON.
 *
 * The full text is not interpreted as HTML. A backup exists to preserve the received full text verbatim.
 *
 * @param content The backup content.
 * @returns UTF-8 bytes without a BOM.
 */
export function encodeBackupContent(content: BackupContent): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    version: content.version,
    documentUri: content.documentUri,
    fullText: content.fullText,
    mergeBase: content.mergeBase,
  }));
}

/**
 * Reads backup content back from UTF-8 JSON.
 *
 * A file whose write stopped midway or a file of another version is not treated as backup content. Restoring a
 * corrupted value as a valid backup would replace the user's edits with different content. The caller verifies
 * that the target URI matches.
 *
 * @param bytes The bytes that were read.
 * @returns The validated backup content, or `undefined` if validation fails.
 */
export function decodeBackupContent(bytes: Uint8Array): BackupContent | undefined {
  let parsed: unknown;
  try {
    // Substituting replacement characters for invalid bytes would return a corrupted full text as a valid backup.
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }
  const version = readField(parsed, 'version');
  const documentUri = readField(parsed, 'documentUri');
  const fullText = readField(parsed, 'fullText');
  const mergeBase = readField(parsed, 'mergeBase');
  if (
    version !== BACKUP_CONTENT_VERSION
    || typeof documentUri !== 'string'
    || typeof fullText !== 'string'
    || typeof mergeBase !== 'string'
  ) {
    return undefined;
  }
  return { version, documentUri, fullText, mergeBase };
}

/**
 * Returns whether two backup contents are the same.
 *
 * @param left A backup content to compare.
 * @param right A backup content to compare.
 * @returns True if every field matches.
 */
export function isSameBackupContent(left: BackupContent, right: BackupContent): boolean {
  return left.version === right.version
    && left.documentUri === right.documentUri
    && left.fullText === right.fullText
    && left.mergeBase === right.mergeBase;
}

/**
 * Reads only an own property from a parsed value.
 *
 * @param value The value parsed from JSON.
 * @param field The property name to read.
 */
function readField(value: object, field: string): unknown {
  return Object.getOwnPropertyDescriptor(value, field)?.value;
}
