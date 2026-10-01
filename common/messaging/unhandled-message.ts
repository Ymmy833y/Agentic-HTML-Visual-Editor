/**
 * Discards a message that the receiver's branching logic did not handle.
 *
 * The parameter is `never` because a value reaching the default branch has that type only after every
 * message type has been handled. An unhandled type remains in the value's type and makes the call fail
 * type checking.
 *
 * @param _message A message that matched none of the known types.
 */
export function discardUnhandledMessage(_message: never): void {
  // Intentionally empty: discarding the message is the entire operation.
}
