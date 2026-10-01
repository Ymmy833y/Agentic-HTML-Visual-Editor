import { VIEW_TO_HOST_MESSAGE_TYPE } from '../../common/index';
import { joinDocument } from '../document/document-boundary';
import type { DocumentBoundary } from '../document/document-boundary';
import type { BodyOutput } from '../document/serialization-state';
import type { EditKind, OutputReceiver } from '../editing/change-tracker';
import type { DeliveryFailureController } from './delivery-failure-controller';
import type { HostChannel } from './host-channel';

/**
 * An output receiver that directly converts edit detections and body outputs into sends to the host.
 *
 * When sending fails, it retains the unsent items, shows the send failure overlay, and stops editing.
 * Otherwise, undelivered edits would keep accumulating and the user would not discover the loss
 * until closing the view. Only synchronous exceptions can be detected; failures after a successful
 * send are not visible to the view.
 */
export class UnsavedContentSender implements OutputReceiver {
  // Whether a view edited message failed to send. The message carries no content, so a boolean is
  // sufficient; its count does not need to be retained.
  private unsentEdit = false;

  // The unsaved content message that failed to send. Retain only the latest item, without a history.
  private unsentContent: { readonly text: string; readonly resent?: true } | undefined;

  /**
   * @param channel The host channel.
   * @param readBoundary A function that reads the determined document boundary.
   * @param failureController The shared delivery failure controller.
   */
  constructor(
    private readonly channel: HostChannel,
    private readonly readBoundary: () => DocumentBoundary | undefined,
    private readonly failureController: DeliveryFailureController,
  ) {}

  /**
   * Receives an edit detection and sends one content-free view edited message.
   *
   * Keep calls and sent messages one-to-one. Do not include the edit kind: nothing consumes it yet,
   * so there is no reason to add information that grows with every send to the contract.
   *
   * @param _kind The kind of edit.
   */
  onEditDetected(_kind: EditKind): void {
    try {
      this.channel.post({ type: VIEW_TO_HOST_MESSAGE_TYPE.viewEdited });
    } catch {
      this.unsentEdit = true;
      this.failureController.reportDeliveryFailure();
    }
  }

  /**
   * Joins a body output with the prologue and epilogue, then sends the complete document text as one
   * unsaved content message.
   *
   * Send even when the content matches the preceding send. Once a view edited message has marked the
   * document as dirty, ensuring that the host holds the latest content is more important.
   *
   * @param output The body output produced after the debounce or by a flush.
   */
  onBodyOutput(output: BodyOutput): void {
    const boundary = this.readBoundary();
    if (boundary === undefined) {
      return;
    }

    const text = joinDocument(boundary, output.body);
    try {
      this.channel.post({ type: VIEW_TO_HOST_MESSAGE_TYPE.unsavedContent, text });
    } catch {
      this.unsentContent = { text };
      this.failureController.reportDeliveryFailure();
    }
  }

  /**
   * Sends, on a save released message, one unsaved content message marked so it can be told apart as a resend.
   *
   * At most one per save released message, and no view edited message goes with it. The only purpose is
   * to bring the host's last known content up to date; sending a view edited message too would make a
   * failed save go round again on every auto save.
   *
   * @param output The body output regenerated after the overlay was lowered.
   */
  resend(output: BodyOutput): void {
    const boundary = this.readBoundary();
    if (boundary === undefined) {
      return;
    }

    const text = joinDocument(boundary, output.body);
    try {
      this.channel.post({ type: VIEW_TO_HOST_MESSAGE_TYPE.unsavedContent, text, resent: true });
    } catch {
      this.unsentContent = { text, resent: true };
      this.failureController.reportDeliveryFailure();
    }
  }

  /**
   * Reports whether an edit notice or unsaved content failed to send and remains undelivered.
   *
   * Returns true while either remains. In this state the host and view content differ, and replacing the tree for an
   * external change would permanently lose the undelivered edit.
   *
   * @returns Whether there is an unsent edit notice or unsaved content.
   */
  hasUnsentContent(): boolean {
    return this.unsentEdit || this.unsentContent !== undefined;
  }

  /**
   * Resends the unsent edit notice and unsaved content in that order, then asks the shared controller to reevaluate.
   *
   * Editing is disabled while the overlay is visible, so sends only retained items without serializing the tree again.
   */
  retry(): void {
    try {
      if (this.unsentEdit) {
        this.channel.post({ type: VIEW_TO_HOST_MESSAGE_TYPE.viewEdited });
        this.unsentEdit = false;
      }
      if (this.unsentContent !== undefined) {
        this.channel.post({
          type: VIEW_TO_HOST_MESSAGE_TYPE.unsavedContent,
          ...this.unsentContent,
        });
        this.unsentContent = undefined;
      }
    } catch {
      // If sending fails again, the undelivered edits remain. Removing the overlay would resume
      // editing despite that failure.
      this.failureController.refresh();
      return;
    }

    this.failureController.refresh();
  }
}
