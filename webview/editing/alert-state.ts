import { ALERT_ATTRIBUTE_NAME, ALERT_KINDS } from '../../common/index';
import type { AlertKind } from '../../common/index';
import { BLOCK_KIND, isConvertibleBlock, readBlockKind } from './block-format';

/**
 * The state identifiers used when the kind is not settled.
 *
 * They are spelled so that they overlap with none of the five kinds, which lets a state be held as a single string.
 */
export const ALERT_STATE = {
  unknown: 'unknownAlert',
  none: 'noAlert',
} as const;

/**
 * The alert state.
 *
 * A known one holds the kind itself as its value, so that a pressed state can be looked up by kind.
 */
export type AlertState = AlertKind | (typeof ALERT_STATE)[keyof typeof ALERT_STATE];

// The reverse lookup from an attribute value to a kind. It is built from the list because `Object.values` would
// widen the type of the keys to `string`.
const ALERT_KIND_BY_VALUE: ReadonlyMap<string, AlertKind> = new Map(
  ALERT_KINDS.map((kind): [string, AlertKind] => [kind, kind]),
);

/**
 * Returns the alert state of a single block.
 *
 * Anything other than a bare blockquote gets `none`, whether or not it carries the attribute. What is answered is
 * the state of what an alert operation acts on, and returning a kind for a block that no rewrite reaches would put
 * the pressed state and the result of pressing out of step.
 *
 * @param target The single block, or `undefined` when there is no target.
 * @returns The alert state.
 */
export function readAlertState(target: Element | undefined): AlertState {
  if (
    target === undefined
    || readBlockKind(target) !== BLOCK_KIND.quote
    || !isConvertibleBlock(target)
  ) {
    return ALERT_STATE.none;
  }

  const value = target.getAttribute(ALERT_ATTRIBUTE_NAME);
  if (value === null) {
    return ALERT_STATE.none;
  }
  // Values differing in case, carrying surrounding whitespace, and empty ones are matched as they stand. Folding
  // them together would open a path that rewrites an unknown value.
  return ALERT_KIND_BY_VALUE.get(value) ?? ALERT_STATE.unknown;
}
