import { runFormatOperation } from './format-command';
import type { FormatCommandPorts } from './format-command';
import type { EditingSession } from './editing-session';
import type { ToggleFormat } from './inline-format';
import type { InputRule } from './input-dispatcher';

/**
 * The input types a rule is registered for, and the toggle format each one means.
 *
 * Format input types outside the five formats, such as underline, are left out. Leaving them out keeps
 * the editing core's default of suppressing them.
 */
export const FORMAT_INPUT_TYPES: Readonly<Record<string, ToggleFormat>> = {
  formatBold: 'bold',
  formatItalic: 'italic',
  formatStrikeThrough: 'strikethrough',
};

/**
 * Registers the input rules for the format input types with the input dispatcher.
 *
 * An editing session is replaced whenever the tree is replaced, so this must be called again each time
 * one is rebuilt.
 *
 * @param session The editing session.
 * @param ports The format command ports.
 */
export function registerFormatRules(session: EditingSession, ports: FormatCommandPorts): void {
  for (const [inputType, format] of Object.entries(FORMAT_INPUT_TYPES)) {
    const rule: InputRule = () => (
      // Never fall through to the default. Falling through lets the browser create `b`, `font`, and
      // `span style`.
      runFormatOperation(ports, { kind: 'toggle', format }, 'rule') ? 'edited' : 'consumed'
    );
    session.registerRule(inputType, rule);
  }
}
