import { VIEW_TO_HOST_MESSAGE_TYPE } from '../../common/index';
import type { ConflictChoice, Localizer, PresentConflictsMessage } from '../../common/index';
import type { HostChannel } from '../messaging/host-channel';
import { buildConflictOverlay, handleConflictOverlayKeyDown } from '../ui/conflict-overlay';
import { INPUT_STOP_REASON } from '../ui/input-stop';
import type { OverlayPresenter } from '../ui/overlay-presenter';

/** The base URIs the previews resolve images against. */
export interface ConflictResolutionDocument {
  /** The document URI. May be empty. */
  readonly documentUri: string;
  /** The resource root URI. May be empty. */
  readonly resourceRootUri: string;
}

/** The ports the conflict resolution receives from outside. */
export interface ConflictResolutionPorts {
  /** The overlay presenter. */
  readonly overlay: OverlayPresenter;
  /** The host channel. */
  readonly channel: HostChannel;
  /** The localizer. */
  readonly localizer: Localizer;
  /** Returns the base URIs of the mounted document. Empty values before the mount. */
  readDocument(): ConflictResolutionDocument;
  /**
   * Sends a one-line diagnostic to the host.
   *
   * @param detail The line.
   */
  reportDiagnostic(detail: string): void;
}

/**
 * Shows the conflict regions of a save on the overlay and sends back what the user chose.
 *
 * The overlay stays up until the choice is sent or the save round trip ends. A choice that could not be sent leaves
 * the overlay and the choices in place, so that the user can press Save again. Exactly one is created per view.
 */
export class ConflictResolution {
  // The presentation on the overlay. `undefined` while the overlay is down.
  private presentationId: number | undefined;

  /**
   * @param view The view's window.
   * @param ports The ports.
   */
  constructor(
    private readonly view: Window,
    private readonly ports: ConflictResolutionPorts,
  ) {
    // Listened to on the window in the capture phase, so that the keys are taken before any other receiver in the
    // view and before the handler VS Code puts on the window.
    view.addEventListener('keydown', (event) => {
      if (this.presentationId !== undefined) {
        handleConflictOverlayKeyDown(event);
      }
    }, true);
  }

  /**
   * Raises the overlay for a presentation. A later presentation of the same save replaces the content, and the
   * choices made for the earlier one are dropped.
   *
   * @param message The presentation.
   */
  present(message: PresentConflictsMessage): void {
    const presentationId = message.presentationId;
    this.presentationId = presentationId;
    this.ports.overlay.present(
      INPUT_STOP_REASON.conflictResolution,
      buildConflictOverlay(this.view.document, this.ports.localizer, message, this.ports.readDocument(), {
        submit: (choices) => this.send(presentationId, choices),
        cancel: () => this.send(presentationId, null),
      }),
    );
  }

  /**
   * Lowers the overlay when the save round trip ends. The host settles the save before it ends the round trip, so a
   * presentation still on the overlay no longer has a save waiting for it.
   */
  handleRoundTripEnded(): void {
    this.lower();
  }

  /**
   * Sends the choice and lowers the overlay once it is sent.
   *
   * @param presentationId The presentation the choice is for.
   * @param choices The choices in document order, or `null` for Cancel.
   */
  private send(presentationId: number, choices: readonly ConflictChoice[] | null): void {
    if (this.presentationId !== presentationId) {
      return;
    }
    try {
      this.ports.channel.post({ type: VIEW_TO_HOST_MESSAGE_TYPE.conflictsResolved, presentationId, choices });
    } catch (error) {
      this.ports.reportDiagnostic(`Could not send the conflict choice: ${String(error)}`);
      return;
    }
    this.lower();
  }

  /** Lowers the overlay. Does nothing while it is down. */
  private lower(): void {
    if (this.presentationId === undefined) {
      return;
    }
    this.presentationId = undefined;
    this.ports.overlay.dismiss(INPUT_STOP_REASON.conflictResolution);
  }
}
