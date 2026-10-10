/**
 * Cancels the default action of a submit event.
 *
 * This is an immutable module-level function so repeated registration on the same editor root during
 * document replacement does not stack listeners. `addEventListener` does not duplicate a registration
 * with the same type, function reference, and capture value. Passing a new anonymous function each
 * time would add one more cancellation on every replacement.
 *
 * @param event The submit event.
 */
function cancelSubmission(event: Event): void {
  event.preventDefault();
}

/**
 * Cancels the default action of submit events that bubble up to the editor root.
 *
 * The `form` and its controls remain in the tree and are rendered. A form authored in an output is
 * part of the document, and hiding it would prevent users from seeing what the document contains.
 *
 * @param root The editor root.
 */
export function blockFormSubmission(root: Element): void {
  root.addEventListener('submit', cancelSubmission);
}
