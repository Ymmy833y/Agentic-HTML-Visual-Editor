/**
 * Input types allowed through to the browser when no rule handles them.
 *
 * Types absent from this set are suppressed because an unknown type could invoke default behavior that damages
 * the structure. Composition text insertion and deletion are allowed because they cannot be canceled anyway.
 */
export const ALLOWED_INPUT_TYPES: ReadonlySet<string> = new Set([
  'insertText',
  'insertLineBreak',
  'insertCompositionText',
  'deleteCompositionText',
  'deleteContentBackward',
  'deleteContentForward',
  'deleteWordBackward',
  'deleteWordForward',
  'deleteSoftLineBackward',
  'deleteSoftLineForward',
  'deleteHardLineBackward',
  'deleteHardLineForward',
]);

/**
 * Context received by an input rule.
 *
 * A rule that does not take over may move `range` and the selection to a visually identical position. The input dispatcher passes the same `range` to every rule,
 * so later rules receive the moved `range`. This is used to shift a delete from a comment edge inside to the outside neighbor so it reaches the block edge rules.
 */
export interface InputContext {
  /** The received input event. */
  readonly event: InputEvent;
  /** The editor root. */
  readonly root: Element;
  /** A selection range contained within the editor root. */
  readonly range: Range;
}

/**
 * Result returned by an input rule.
 *
 * `pass` means the rule did not handle the input, `edited` means it handled and changed the tree, and `consumed`
 * means it handled the input without changing the tree.
 */
export type InputRuleResult = 'pass' | 'edited' | 'consumed';

/** A rule that decides whether to handle input and, if handled, changes the tree and selection. */
export type InputRule = (context: InputContext) => InputRuleResult;

/** Receives one-line diagnostics for maintainers only; never used for user notifications. */
export type DiagnosticReporter = (detail: string) => void;

/** Dispatch result indicating whether a rule handled the input or which default treatment was applied. */
export type DispatchResult = 'edited' | 'consumed' | 'allowed' | 'prevented';

/**
 * Formats a thrown value to fit in a one-line diagnostic.
 *
 * Rules may throw any value, so values other than `Error` are accepted.
 *
 * @param error The caught value.
 * @returns Text for the diagnostic.
 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Appends a rule to the queue for an input type.
 *
 * @param queues The queues by input type.
 * @param inputType The target input type.
 * @param rule The rule to add.
 */
function append(queues: Map<string, InputRule[]>, inputType: string, rule: InputRule): void {
  const queue = queues.get(inputType);
  if (queue === undefined) {
    queues.set(inputType, [rule]);
    return;
  }
  queue.push(rule);
}

/** Holds a queue of rules per input type and tries incoming input against each queue from the front. */
export class InputDispatcher {
  private readonly rules = new Map<string, InputRule[]>();

  private readonly fallbacks = new Map<string, InputRule[]>();

  /**
   * @param root The editor root included in the context passed to rules.
   * @param reportDiagnostic Receives reports of rule failures for maintainers.
   */
  constructor(
    private readonly root: Element,
    private readonly reportDiagnostic: DiagnosticReporter,
  ) {}

  /**
   * Appends a rule to the queue for an input type. Registration order is priority order.
   *
   * @param inputType The target input type.
   * @param rule The rule to add.
   */
  register(inputType: string, rule: InputRule): void {
    append(this.rules, inputType, rule);
  }

  /**
   * Adds a rule to the fallback queue, which is tried only when no rule in the main queue took over.
   *
   * The built-in replacements that always take over (Enter inside a `pre`, deletion at the edge of a block) are
   * moved here. While they sit at the head of the main queue, no specific rule registered later is ever tried.
   *
   * @param inputType The input type to register for.
   * @param rule The rule to add.
   */
  registerFallback(inputType: string, rule: InputRule): void {
    append(this.fallbacks, inputType, rule);
  }

  /**
   * Tries the queue in registration order and stops default behavior when the first rule handles the input.
   *
   * @param event The received input event.
   * @param range A selection range contained within the editor root.
   * @returns The handling rule's result, or the default treatment when no rule handled the input.
   */
  dispatch(event: InputEvent, range: Range): DispatchResult {
    // The fallback queue is tried only after the main queue has been exhausted.
    const queue = [
      ...(this.rules.get(event.inputType) ?? []),
      ...(this.fallbacks.get(event.inputType) ?? []),
    ];

    for (const rule of queue) {
      let result: InputRuleResult;
      try {
        result = rule({ event, root: this.root, range });
      } catch (error) {
        // Falling through to default behavior after a rule fails could send a damaged structure to output.
        // Suppressing it while continuing to accept later input is safer. Record a maintainer diagnostic so the
        // reason the input had no effect can still be traced.
        event.preventDefault();
        this.reportDiagnostic(
          `Suppressed default editing because a rule for input type ${event.inputType} threw an exception: ${describeError(error)}`,
        );
        return 'prevented';
      }

      if (result === 'pass') {
        continue;
      }
      event.preventDefault();
      return result;
    }

    if (ALLOWED_INPUT_TYPES.has(event.inputType)) {
      return 'allowed';
    }
    event.preventDefault();
    return 'prevented';
  }
}
