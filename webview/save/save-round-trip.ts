import { VIEW_TO_HOST_MESSAGE_TYPE } from '../../common/index';
import type { RequestId, ViewToHostMessage } from '../../common/index';
import type { BodyOutput } from '../document/serialization-state';
import type { HostChannel } from '../messaging/host-channel';
import { INPUT_STOP_REASON } from '../ui/input-stop';
import { BLANK_OVERLAY_CONTENT } from '../ui/overlay-presenter';
import type { OverlayPresenter } from '../ui/overlay-presenter';

/**
 * What one round of output generation yields.
 *
 * What is sent to the host is the whole text joined with the prologue and epilogue, but replacing the
 * three baselines on a save committed message needs the body and the `current`. The save round trip
 * does not know the document boundary, so it receives the text with that joining already done.
 */
export interface SaveRoundTripOutput {
  /** The complete LF-delimited document text. */
  readonly text: string;
  /** The body output used for replacing the baselines and for a resend. */
  readonly output: BodyOutput;
}

/** The channel the save round trip receives from outside. */
export interface SaveRoundTripContext {
  /**
   * The overlay presenter. Editability, focus and the selection are never touched directly; they go
   * through it.
   */
  readonly overlay: OverlayPresenter;

  /** The host channel. */
  readonly channel: HostChannel;

  /** Produces output from the current tree, or `undefined` when it cannot be produced. */
  createOutput(): SaveRoundTripOutput | undefined;

  /** Drops the pending debounce without flushing it. */
  discardPendingOutput(): void;

  /**
   * Sends one marked unsaved content message.
   *
   * @param output The body output to send.
   */
  resendUnsavedContent(output: BodyOutput): void;
}

/**
 * Stops input in the view and returns the output for the duration of a save round trip, restoring
 * everything on the signal that ends it.
 *
 * There is one per view, and it is not recreated on a document replacement. The editing session and
 * the unsaved content sender are swapped by a replacement, so they are read through the context on
 * every call.
 */
export class SaveRoundTrip {
  // The output produced most recently. It is used as the written body when a save committed message arrives.
  private lastOutput: SaveRoundTripOutput | undefined;

  /**
   * @param context The channel the save round trip uses.
   */
  constructor(private readonly context: SaveRoundTripContext) {}

  /**
   * Stops input on a request body output message and returns one body output response from the same handler.
   *
   * The order — raise the overlay, drop the pending debounce, produce the output — must not be disturbed.
   * Raising the overlay finishes the input stop synchronously, so the output can be produced within
   * the same handler afterwards. Finishing output generation inside the same handler guarantees
   * that every character typed before the request arrived is in this output.
   *
   * @param requestId The request ID to put on the response.
   */
  handleOutputRequest(requestId: RequestId): void {
    this.context.overlay.present(INPUT_STOP_REASON.saveRoundTrip, BLANK_OVERLAY_CONTENT);
    this.context.discardPendingOutput();

    const output = this.context.createOutput();
    this.lastOutput = output;

    // Respond even when the output could not be produced. Without a response the host waits until its
    // timeout, leaving the dirty mark and the edits in limbo.
    this.post({
      type: VIEW_TO_HOST_MESSAGE_TYPE.bodyOutputResponse,
      requestId,
      text: output?.text ?? null,
    });
  }

  /**
   * Reads the most recently returned output.
   *
   * Document apply uses this to determine whether a save candidate matches the view output. Returns `undefined`
   * outside a round trip.
   *
   * @returns The most recently returned full text, body, and current form, or `undefined` outside a round trip.
   */
  readLastOutput(): SaveRoundTripOutput | undefined {
    return this.lastOutput;
  }

  /**
   * Lowers the overlay after receiving a commit.
   *
   * The three baselines were already replaced when the save candidate was applied. Replacing them here as well could
   * use content different from the application-time values. The message remains as a signal so the side that raised
   * the overlay receives exactly one matching release.
   */
  handleCommitted(): void {
    this.lower();
  }

  /**
   * Lowers only the overlay on a save released message, leaving the three baselines unchanged.
   *
   * @param resendUnsavedContent Whether to resend one marked unsaved content message.
   */
  handleReleased(resendUnsavedContent: boolean): void {
    this.lower();

    if (!resendUnsavedContent) {
      return;
    }

    // Send the content regenerated at this point, after the overlay has been lowered. The single
    // message sent here covers the pending debounce that was dropped when the overlay was raised.
    const output = this.context.createOutput();
    if (output === undefined) {
      return;
    }
    this.context.resendUnsavedContent(output.output);
  }

  /**
   * Discards the most recent output on learning that the protection has been entered.
   *
   * The overlay for the protection is raised, under its own reason, by whoever receives the
   * protection notice. Raising it here would mean that removing the round trip's reason also lifted
   * the stop that belongs to the protection.
   */
  handleProtectionActivated(): void {
    this.lastOutput = undefined;
  }

  /**
   * Removes only the round trip's own reason.
   *
   * The stops for the protection and for a restore that has not settled are removed by their own
   * owners. Whether editability, focus and the selection are restored is decided by the input stop
   * controller, from whether any reason remains.
   */
  private lower(): void {
    this.context.overlay.dismiss(INPUT_STOP_REASON.saveRoundTrip);
    this.lastOutput = undefined;
  }

  /**
   * Sends to the host, turning a failed send into one diagnostic line.
   *
   * @param message The message to send.
   */
  private post(message: ViewToHostMessage): void {
    try {
      this.context.channel.post(message);
    } catch (error) {
      try {
        this.context.channel.post({
          type: VIEW_TO_HOST_MESSAGE_TYPE.viewDiagnostic,
          detail: `Failed to send ${message.type} to the host: ${String(error)}`,
        });
      } catch {
        // If even the diagnostic cannot be sent, the view has no way to report it. Throwing here would
        // leave the overlay raised.
      }
    }
  }
}
