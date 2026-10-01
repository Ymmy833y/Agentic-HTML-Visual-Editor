/**
 * The name of the test mode meta, embedded only in views launched in Test mode, that lets them accept test-only
 * controls.
 *
 * The host embeds it and the view reads it. If the names diverge, every control is rejected even in Test mode.
 */
export const TEST_MODE_META_NAME = 'ahve-test-mode';

/**
 * Types of test-only messages.
 *
 * Kept distinct from the values of the production discriminated union. Sharing a type name would let the
 * production receive branch handle a test control as an ordinary message.
 */
export const TEST_MESSAGE_TYPE = {
  backupTestControl: 'backupTestControl',
  backupTestControlResult: 'backupTestControlResult',
} as const;

/**
 * Controls that integration tests request from the view.
 *
 * The extension host cannot send key input to the view, so unresponsiveness and "an edit closed before output"
 * are produced through these controls.
 */
export const BACKUP_TEST_OPERATION = {
  /** Stops only the responses to output requests. */
  suspendOutputResponses: 'suspendOutputResponses',
  /** Resumes the stopped responses. */
  resumeOutputResponses: 'resumeOutputResponses',
  /** Changes the tree with the same kind as typing and leaves the body output waiting on the debounce. */
  prepareUnsentEdit: 'prepareUnsentEdit',
} as const;

/** The kind of control a test requests. */
export type BackupTestOperation = (typeof BACKUP_TEST_OPERATION)[keyof typeof BACKUP_TEST_OPERATION];

/** Messages sent from the host to the view only for testing. */
export interface TestHostToViewMessage {
  readonly type: typeof TEST_MESSAGE_TYPE.backupTestControl;
  /** An identifier that matches the result to the control. */
  readonly controlId: string;
  readonly operation: BackupTestOperation;
  /** The text appended when preparing an unsent edit. Unused by other controls. */
  readonly text?: string;
}

/** Messages sent from the view to the host only for testing. */
export interface TestViewToHostMessage {
  readonly type: typeof TEST_MESSAGE_TYPE.backupTestControlResult;
  readonly controlId: string;
  /** True only if the control was accepted and executed. A view without the test mode meta always returns false. */
  readonly success: boolean;
}
