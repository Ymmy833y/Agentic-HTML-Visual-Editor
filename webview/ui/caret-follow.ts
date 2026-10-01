import { NO_CARET_STATE, readCaretState } from '../editing/caret-state';
import type { CaretState } from '../editing/caret-state';
import type { EditingSession } from '../editing/editing-session';

/**
 * Ports of the caret follow. None of them hold a value; each is read on every call, because
 * document replacement swaps what is behind them.
 */
export interface CaretFollowPorts {
  /** Returns the editor root. */
  readEditorRoot(): HTMLElement | undefined;

  /**
   * Reflects the caret state onto the fixed toolbar.
   *
   * @param state The caret state.
   */
  reflect(state: CaretState): void;

  /**
   * Reflects the caret state onto the floating menu's display.
   *
   * @param state The caret state.
   */
  applyMenuState(state: CaretState): void;

  /** Corrects the position of the floating menu while it is shown. */
  updateMenuPosition(): void;

  /** Whether the floating menu is shown. */
  isMenuVisible(): boolean;

  /**
   * Records one diagnostic line for maintainers.
   *
   * @param detail The line to record.
   */
  reportDiagnostic(detail: string): void;
}

/**
 * Observes follow triggers and drives everything from evaluation to reflection and display updates.
 *
 * Created once per view and not recreated on remount. Consecutive triggers are coalesced into one
 * with a one-frame wait. Evaluating on every trigger would run the queries dozens of times during a
 * drag selection and clog the input path.
 */
export class CaretFollow {
  // The reflected caret state. Kept across remounts, and replaced on every evaluation even when the
  // value equals the previous one.
  private state: CaretState = NO_CARET_STATE;

  // The coalescing wait. Triggers that arrive while it is pending are folded into it.
  private pending: number | undefined;

  // Whether the wait includes a follow trigger. If not, updating the position is enough.
  private pendingEvaluation = false;

  // Whether selection change, scroll, and resize have been subscribed to.
  private subscribed = false;

  private readonly onFollowTrigger = (): void => {
    this.pendingEvaluation = true;
    this.runGuarded(() => this.schedule());
  };

  private readonly onPositionTrigger = (): void => {
    this.runGuarded(() => {
      if (!this.ports.isMenuVisible()) {
        // While hidden there is no position to correct. Scheduling a wait on every scroll would keep
        // waits running just from reading.
        return;
      }
      this.schedule();
    });
  };

  /**
   * @param view The view's window.
   * @param ports Ports of the caret follow.
   */
  constructor(
    private readonly view: Window,
    private readonly ports: CaretFollowPorts,
  ) {}

  /**
   * Attaches subscriptions in response to a successful mount and evaluates once.
   *
   * The edit trigger is carried by that mount's editing session, so it is re-registered on every
   * remount. Selection changes and position triggers are attached to the view, so they are
   * subscribed to only the first time.
   *
   * @param session That mount's editing session. Only its registration port is taken; the editing
   *   internals are not touched.
   */
  handleMountCompleted(session: Pick<EditingSession, 'addEditListener'>): void {
    session.addEditListener(this.onFollowTrigger);

    if (!this.subscribed) {
      this.subscribed = true;
      this.view.document.addEventListener('selectionchange', this.onFollowTrigger);
      // Scrolling of inner elements does not bubble up, so it is received in the capture phase.
      this.view.addEventListener('scroll', this.onPositionTrigger, true);
      this.view.addEventListener('resize', this.onPositionTrigger);
    }

    // Evaluate after subscribing. In the reverse order, the display would reflect the state before
    // subscribing and stay that way until the next trigger.
    this.evaluate();
  }

  /**
   * Evaluates the current selection and proceeds synchronously through reflection and the display
   * update. Does not let exceptions escape.
   */
  evaluate(): void {
    this.runGuarded(() => {
      const root = this.ports.readEditorRoot();
      // Update even when the value equals the previous one. Skipping reflection by comparing values
      // would leave a stale display when only the tree has changed.
      this.state = root === undefined ? NO_CARET_STATE : readCaretState(root);
      this.ports.reflect(this.state);
      this.ports.applyMenuState(this.state);
    });
  }

  /** Schedules the coalescing wait. If one is already pending, it is not extended; the trigger is folded into it. */
  private schedule(): void {
    if (this.pending !== undefined) {
      return;
    }

    this.pending = this.view.requestAnimationFrame(() => {
      this.pending = undefined;
      const evaluates = this.pendingEvaluation;
      this.pendingEvaluation = false;
      if (evaluates) {
        // Evaluation proceeds through the display update, which also decides the position.
        // Do not call the position update on top of it.
        this.evaluate();
        return;
      }
      this.runGuarded(() => this.ports.updateMenuPosition());
    });
  }

  /**
   * Runs display work without letting exceptions escape.
   *
   * Triggers are carried by the edit notification and by browser listeners. Returning an exception
   * to them would stop the edit itself midway merely because following failed.
   *
   * @param action The work to run.
   */
  private runGuarded(action: () => void): void {
    try {
      action();
    } catch (error) {
      this.ports.reportDiagnostic(`Could not follow the caret: ${String(error)}`);
    }
  }
}
