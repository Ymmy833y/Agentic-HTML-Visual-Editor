/**
 * The list of alert kinds.
 *
 * It is held as an ordered array because that order is also what the display emphasis and the order of the items
 * follow. It is read-only because a value added at run time would be treated as a known kind, which would put the
 * line the display draws and the line the decisions draw out of step.
 */
export const ALERT_KINDS = ['note', 'tip', 'important', 'warning', 'caution'] as const;

/** An alert kind. No value outside the list can be taken. */
export type AlertKind = (typeof ALERT_KINDS)[number];

/** The name of the attribute that gives a blockquote its alert kind. Neither the checks nor the rewrites respell it. */
export const ALERT_ATTRIBUTE_NAME = 'data-alert';
