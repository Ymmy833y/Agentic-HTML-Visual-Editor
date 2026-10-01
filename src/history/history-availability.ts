/**
 * Whether custom document edit events and delegation of undo/redo to the standard commands are enabled.
 *
 * VS Code does not allow one custom editor provider to mix edit events with plain change events. A user
 * setting could switch the form while running, so this is a constant read once at startup.
 *
 * Enabled because the mechanism is now wired that, when applying fails, writes the old full text to an
 * independent backup and withholds the failure response until the read-back is verified. Edit events fire only
 * once per edit unit, so backup freshness is kept by rewriting the backup whenever the retained copy updates.
 */
export const HISTORY_EVENTS_ENABLED: boolean = true;
