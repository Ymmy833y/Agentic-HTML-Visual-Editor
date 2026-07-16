// Shared definitions for GitHub-style alert blockquotes.

export const ALERT_TYPES = ['note', 'tip', 'important', 'warning', 'caution'] as const;

export type AlertType = (typeof ALERT_TYPES)[number];

export interface AlertDefinition {
  type: AlertType;
  label: string;
}

export const ALERT_DEFINITIONS: readonly AlertDefinition[] = [
  { type: 'note', label: 'Note' },
  { type: 'tip', label: 'Tip' },
  { type: 'important', label: 'Important' },
  { type: 'warning', label: 'Warning' },
  { type: 'caution', label: 'Caution' },
];

const ALERT_TYPE_SET = new Set<string>(ALERT_TYPES);

export function isAlertType(value: string | null): value is AlertType {
  return value !== null && ALERT_TYPE_SET.has(value);
}

export function alertTypeFromShortcut(marker: string): AlertType | null {
  const normalized = marker.toLowerCase();
  return isAlertType(normalized) ? normalized : null;
}

export function alertLabel(type: AlertType): string {
  return ALERT_DEFINITIONS.find((definition) => definition.type === type)?.label ?? 'Alert';
}
