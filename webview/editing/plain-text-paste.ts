import { readSelectionRange } from './caret';
import type { ShortcutKey, ShortcutOutcome, ShortcutReceiver } from './shortcut-receiver';

/**
 * The key combination for pasting as plain text. Requires the character v, the primary modifier, and Shift, and
 * requires no Alt.
 *
 * It matches by character, so on layouts that do not type Latin letters the receiver matches by position.
 */
export const PLAIN_TEXT_PASTE_KEY: ShortcutKey = { character: 'v', primary: true, shift: true, alt: false };

/**
 * The plain text paste edit kind.
 *
 * History groups only typing and deletes, so this spelling differs from both and is never grouped with the input
 * before or after it. One paste becomes one standalone edit.
 */
export const PLAIN_TEXT_PASTE_EDIT_KIND = 'clipboard:pastePlainText';

/**
 * Ports of plain text paste.
 *
 * The ports hold no values and read them on every call. Reading the clipboard is asynchronous and uses the editing
 * session (recreated on document replacement) and input blocking current when the read finishes.
 */
export interface PlainTextPastePorts {
  /** Returns the editor root, or `undefined` before mounting. */
  readEditorRoot(): Element | undefined;

  /** Whether IME composition is in progress at the time of the call. */
  isComposing(): boolean;

  /** Whether any reason for stopping input remains. */
  isInputStopped(): boolean;

  /**
   * Starts reading the text from the clipboard.
   *
   * @returns A promise of the text read.
   */
  readClipboardText(): Promise<string>;

  /**
   * Runs a command that changes the tree as one edit attempt spanning the states before and after it.
   *
   * @param kind The edit kind.
   * @param command A command that returns true only when it changed the tree.
   * @returns Whether the tree changed. False if the attempt could not be opened.
   */
  runCommandEdit(kind: string, command: () => boolean): boolean;

  /**
   * Deletes the range, then inserts the text split into lines.
   *
   * @param text The text to paste.
   * @param range The range to insert into.
   * @returns Whether the tree changed.
   */
  pasteText(text: string, range: Range): boolean;

  /** Leaves one diagnostic line for maintainers. Not used to notify users. */
  reportDiagnostic(detail: string): void;
}

/**
 * Registers, at the end of the receiver's list, an item that pastes as plain text on primary modifier+Shift+V.
 *
 * There is one receiver for the lifetime of the view, and it survives document replacement, so call this only once,
 * on the first mount.
 *
 * @param receiver The receiver.
 * @param ports The ports.
 */
export function registerPlainTextPasteShortcut(
  receiver: Pick<ShortcutReceiver, 'register'>,
  ports: PlainTextPastePorts,
): void {
  receiver.register({ key: PLAIN_TEXT_PASTE_KEY, run: () => startPlainTextPaste(ports) });
}

/**
 * Takes the key and stops the default, then starts reading the text from the clipboard unless composition is in
 * progress.
 *
 * The default is always stopped. Left to the default, the browser's "Paste and Match Style" runs on some OSes and not
 * on others. The read starts inside the key handling, because VS Code only allows reads that follow a user action and
 * rejects one started after waiting. Input is not stopped during the read, and multiple reads are inserted in the order
 * they finish.
 *
 * @param ports The ports.
 * @returns Always `preventDefault`.
 */
export function startPlainTextPaste(ports: PlainTextPastePorts): ShortcutOutcome {
  // Changing the tree during composition breaks the composition. To paste, commit the composition and try again.
  if (ports.isComposing()) {
    return 'preventDefault';
  }
  try {
    void ports.readClipboardText().then(
      (text) => {
        applyPlainTextPaste(ports, text);
      },
      (error: unknown) => {
        ports.reportDiagnostic(`Could not read the text from the clipboard: ${String(error)}`);
      },
    );
  } catch (error) {
    ports.reportDiagnostic(`Could not start reading the text from the clipboard: ${String(error)}`);
  }
  return 'preventDefault';
}

/**
 * Inserts the text that was read at the selection current when the read finished, inside one command-path edit
 * attempt. The range is deleted before inserting.
 *
 * Input is not stopped during the read, so the preconditions are checked again when the read finishes.
 *
 * @param ports The ports.
 * @param text The text read.
 * @returns Whether the tree changed.
 */
export function applyPlainTextPaste(ports: PlainTextPastePorts, text: string): boolean {
  const root = ports.readEditorRoot();
  if (text === '' || root === undefined || ports.isComposing() || ports.isInputStopped()) {
    return false;
  }
  const range = readSelectionRange(root);
  if (range === undefined) {
    return false;
  }
  const before = root.innerHTML;
  return ports.runCommandEdit(PLAIN_TEXT_PASTE_EDIT_KIND, () => {
    try {
      return ports.pasteText(text, range);
    } catch (error) {
      // Close whatever changed before the exception as one edit too. Closing it as aborted would make the display and
      // the saved content disagree.
      ports.reportDiagnostic(`Could not paste as plain text: ${String(error)}`);
      return root.innerHTML !== before;
    }
  });
}
