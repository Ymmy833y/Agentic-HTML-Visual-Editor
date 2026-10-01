import type { DiagnosticReporter } from './input-dispatcher';

/** The shortcut platform that decides the primary modifier: Cmd on macOS-like systems, Ctrl elsewhere. */
export type ShortcutPlatform = 'mac' | 'other';

/** Which modifiers are required. A key press matches the shortcut key only when these match exactly. */
interface ShortcutModifiers {
  /** Whether the primary modifier (Cmd on macOS, Ctrl elsewhere) is required. */
  readonly primary: boolean;
  /** Whether Shift is required. */
  readonly shift: boolean;
  /** Whether Alt (Option on macOS) is required. */
  readonly alt: boolean;
}

/**
 * A shortcut key: exactly one of a character or a position, plus which modifiers are required.
 *
 * Keys whose character changes with Shift or Alt, such as digits, are matched by position. Keys whose position
 * differs between layouts, such as `\`, are matched by character. The character is held in lower case, and the
 * position is held as a `code` value.
 */
export type ShortcutKey =
  | (ShortcutModifiers & { readonly character: string })
  | (ShortcutModifiers & { readonly code: string });

/**
 * The outcome of a shortcut's action.
 *
 * `pass` does not take the key over. `preventDefault` takes it over and also stops the browser's default action.
 * `allowDefault` takes it over but lets the default action through.
 * Letting the default through is allowed only for keys whose default action reaches the input dispatcher with an input
 * type (bold, italic) and keys whose default action does not change the tree (Escape).
 */
export type ShortcutOutcome = 'pass' | 'preventDefault' | 'allowDefault';

/**
 * A shortcut registered with the receiver: a pair of a shortcut key and an action that takes the key press and
 * returns an outcome.
 *
 * The action does not rewrite the tree directly; it calls each feature's command entry point. Rewriting the tree
 * from the receiver would create a rewriting path that bypasses the edit attempt and the change tracker.
 */
export interface Shortcut {
  /** The shortcut key to match. */
  readonly key: ShortcutKey;

  /**
   * Takes the key press and returns whether to take it over.
   *
   * @param event The key press that matched the shortcut key.
   * @returns The outcome of the action.
   */
  run(event: KeyboardEvent): ShortcutOutcome;
}

// Words that macOS-like user agents announce.
const MAC_USER_AGENT_PATTERN = /Macintosh|iPhone|iPad/u;

// The keyCode attached to key presses consumed by the IME. Checked so they can be told apart even in browsers that
// do not set the key value to Process.
const IME_PROCESS_KEY_CODE = 229;

// The case-folding `i` flag is not used, because combined with the `u` flag it also counts ſ and K (the Kelvin
// sign) as letters.
const ASCII_LETTER_PATTERN = /^[A-Za-z]$/u;
const ASCII_ALPHANUMERIC_PATTERN = /^[0-9A-Za-z]$/u;

/**
 * Decides the shortcut platform from the user agent.
 *
 * @param userAgent The view's user agent.
 * @returns `mac` if it contains Macintosh, iPhone or iPad, and `other` otherwise.
 */
export function readShortcutPlatform(userAgent: string): ShortcutPlatform {
  return MAC_USER_AGENT_PATTERN.test(userAgent) ? 'mac' : 'other';
}

/**
 * Matches a shortcut key against a key press.
 *
 * Modifiers are compared for an exact match. Allowing extra modifiers would let the view steal keys that have
 * bindings on the VS Code side, such as Ctrl+Shift+B.
 *
 * @param key The shortcut key.
 * @param event The key press.
 * @param platform The shortcut platform.
 * @returns `true` if they match.
 */
export function matchesShortcutKey(
  key: ShortcutKey,
  event: KeyboardEvent,
  platform: ShortcutPlatform,
): boolean {
  const primary = platform === 'mac' ? event.metaKey : event.ctrlKey;
  // A key press with the Ctrl / Cmd that is not the primary modifier means something else (on macOS, Ctrl is used
  // for moving the cursor).
  const secondary = platform === 'mac' ? event.ctrlKey : event.metaKey;
  if (
    secondary
    || primary !== key.primary
    || event.shiftKey !== key.shift
    || event.altKey !== key.alt
  ) {
    return false;
  }

  if ('code' in key) {
    return event.code === key.code;
  }
  if (event.key.toLowerCase() === key.character) {
    return true;
  }
  // On layouts that do not type Latin letters (Russian, for example), the key value never reaches a letter shortcut
  // key, so only then is the position matched instead. When the key value is a letter, the position is not checked,
  // so that layouts with a different letter arrangement (Dvorak, for example) do not steal the key of another letter.
  return ASCII_LETTER_PATTERN.test(key.character)
    && !ASCII_LETTER_PATTERN.test(event.key)
    && event.code === `Key${key.character.toUpperCase()}`;
}

/**
 * Returns whether the key press types an AltGr character.
 *
 * Windows delivers AltGr as Ctrl+Alt, so matching it would let Ctrl+Alt shortcuts steal input such as @ and #. The
 * key value alone cannot tell a character typed with AltGr from the default character of a digit key (such as & on
 * the French layout), so every key press whose key value is not an ASCII alphanumeric is treated as character
 * input. macOS has no AltGr that arrives as Ctrl+Alt, so this is always false there.
 *
 * @param event The key press.
 * @param platform The shortcut platform.
 * @returns `true` if the key press types an AltGr character.
 */
export function isAltGraphCharacter(event: KeyboardEvent, platform: ShortcutPlatform): boolean {
  if (platform === 'mac' || !event.ctrlKey || !event.altKey) {
    return false;
  }
  if (event.key === 'Dead') {
    return true;
  }
  return [...event.key].length === 1 && !ASCII_ALPHANUMERIC_PATTERN.test(event.key);
}

/**
 * Returns whether the key press is one the IME delivers as being processed.
 *
 * Being in a composition alone does not make this true. Key presses the IME did not consume are matched even during
 * a composition, and what to do during a composition is left to the shortcut's action.
 *
 * @param event The key press.
 * @returns `true` if the key value is Process or the keyCode is 229.
 */
export function isImeProcessKey(event: KeyboardEvent): boolean {
  return event.key === 'Process' || event.keyCode === IME_PROCESS_KEY_CODE;
}

/**
 * The receiver for key input in the editor root. It matches registered shortcuts in registration order and keeps the
 * key from reaching VS Code at the first shortcut that takes it over.
 *
 * The VS Code webview forwards keydown to the workbench even when the page stops the default action. The forwarding
 * can be stopped only when propagation does not reach the inner window. Only one is created per view.
 */
export class ShortcutReceiver {
  // Registration order is the priority order. There is no way to unregister.
  private readonly shortcuts: Shortcut[] = [];

  /**
   * @param platform The shortcut platform.
   * @param reportDiagnostic The diagnostic reporter for maintainers.
   */
  constructor(
    private readonly platform: ShortcutPlatform,
    private readonly reportDiagnostic: DiagnosticReporter,
  ) {}

  /**
   * Appends a shortcut to the end of the list.
   *
   * If several shortcuts have the same shortcut key, the one added first is tried first (for example, to split Tab
   * between lists and tables).
   *
   * @param shortcut The shortcut to add.
   */
  register(shortcut: Shortcut): void {
    this.shortcuts.push(shortcut);
  }

  /**
   * Matches a key press aimed at the editor root and stops propagation if a shortcut takes it over.
   *
   * Whether a composition is in progress is not checked here. What to do during a composition is decided by the
   * shortcut's action.
   *
   * @param event The key press.
   */
  handleKeyDown(event: KeyboardEvent): void {
    if (isImeProcessKey(event) || isAltGraphCharacter(event, this.platform)) {
      // Do not steal key presses that become character input as shortcuts.
      return;
    }

    for (const shortcut of this.shortcuts) {
      if (!matchesShortcutKey(shortcut.key, event, this.platform)) {
        continue;
      }

      let outcome: ShortcutOutcome;
      try {
        outcome = shortcut.run(event);
      } catch (error) {
        // Letting it through without stopping would make a key the view is supposed to handle trigger a command on
        // the VS Code side. Leave a diagnostic so the reason the key had no effect can be traced, and do not try
        // the shortcuts after this one.
        event.stopPropagation();
        event.preventDefault();
        this.reportDiagnostic(`Stopped the key because the shortcut action threw an exception: ${String(error)}`);
        return;
      }

      if (outcome === 'pass') {
        continue;
      }
      event.stopPropagation();
      if (outcome === 'preventDefault') {
        event.preventDefault();
      }
      return;
    }
  }

  /**
   * Returns only whether the pressed key matches any registered shortcut. It calls no operation and
   * changes neither propagation nor the default action.
   *
   * Used to keep registered keys from being passed to VS Code's key bindings while focus is outside
   * the editor root (such as on the toolbar). Matching follows the same rules as the receiver, so no
   * copy of the keys is held outside.
   *
   * @param event The key press.
   * @returns `true` when a shortcut matches. Always `false` for an IME process key and an AltGr
   *   character.
   */
  hasShortcut(event: KeyboardEvent): boolean {
    if (isImeProcessKey(event) || isAltGraphCharacter(event, this.platform)) {
      return false;
    }
    return this.shortcuts.some((shortcut) => matchesShortcutKey(shortcut.key, event, this.platform));
  }
}

/**
 * Creates the receiver and has it subscribe to keydown on the editor root in the bubbling phase.
 *
 * VS Code receives keydown in the bubbling phase of the inner window and forwards it, so stopping propagation at the
 * editor root keeps the key from getting there. Capture-phase subscriptions on the document (popups, tooltips,
 * dialogs) run before the receiver, so they are not affected by the stop. Keys aimed outside the editor root, and
 * keys pressed during an input stop that takes focus away from the editor root, never reach the receiver.
 *
 * @param root The editor root.
 * @param platform The shortcut platform.
 * @param reportDiagnostic The diagnostic reporter for maintainers.
 * @returns The attached receiver.
 */
export function attachShortcutReceiver(
  root: HTMLElement,
  platform: ShortcutPlatform,
  reportDiagnostic: DiagnosticReporter,
): ShortcutReceiver {
  const receiver = new ShortcutReceiver(platform, reportDiagnostic);
  root.addEventListener('keydown', (event) => receiver.handleKeyDown(event));
  return receiver;
}
