import type { Localizer } from '../../common/index';
import { INPUT_STOP_REASON } from '../ui/input-stop';
import type { OverlayPresenter } from '../ui/overlay-presenter';
import { buildSendFailureOverlay } from '../ui/send-failure-overlay';

interface DeliveryRoute {
  readonly hasUnsent: () => boolean;
  readonly retry: () => void;
}

/** Combines delivery failures for unsaved content and history into one input-blocked state. */
export class DeliveryFailureController {
  private readonly routes = new Map<string, DeliveryRoute>();

  private deliveryFailed = false;

  private captureFailed = false;

  private disposed = false;

  constructor(
    private readonly overlay: OverlayPresenter,
    private readonly localizer: Localizer,
    private readonly reportDiagnostic: (detail: string) => void,
  ) {}

  /** Registers a route's unsent-state query and retry entry point. */
  registerRoute(name: string, hasUnsent: () => boolean, retry: () => void): void {
    if (this.disposed) {
      return;
    }
    this.routes.set(name, { hasUnsent, retry });
  }

  /** Records a delivery failure and blocks input with the shared overlay. */
  reportDeliveryFailure(): void {
    if (this.disposed) {
      return;
    }
    this.deliveryFailed = true;
    this.render();
  }

  /** Retains a capture failure until a new editing session and reports its technical cause once. */
  reportCaptureFailure(detail: string): void {
    if (this.disposed || this.captureFailed) {
      return;
    }
    this.captureFailed = true;
    this.reportDiagnostic(detail);
    this.render();
  }

  /** Retries every route with unsent items once and independently. */
  retry(): void {
    if (this.disposed) {
      return;
    }
    for (const route of this.routes.values()) {
      if (!route.hasUnsent()) {
        continue;
      }
      try {
        route.retry();
      } catch (error) {
        this.reportDiagnostic(`An exception occurred while retrying delivery: ${String(error)}`);
      }
    }
    this.refresh();
  }

  /** Reevaluates the overlay and whether editing is allowed from each route's current state. */
  refresh(): void {
    if (this.disposed) {
      return;
    }
    this.deliveryFailed = [...this.routes.values()].some((route) => route.hasUnsent());
    this.render();
  }

  /** Disposes the routes and failure causes from the old editing session. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.routes.clear();
    this.deliveryFailed = false;
    this.captureFailed = false;
    this.overlay.dismiss(INPUT_STOP_REASON.sendFailure);
  }

  /**
   * Rebuilds the content from the failures that remain and updates the overlay, lowering it once
   * both are gone.
   */
  render(): void {
    if (!this.deliveryFailed && !this.captureFailed) {
      this.overlay.dismiss(INPUT_STOP_REASON.sendFailure);
      return;
    }
    this.overlay.present(
      INPUT_STOP_REASON.sendFailure,
      buildSendFailureOverlay(
        this.localizer,
        { deliveryFailed: this.deliveryFailed, captureFailed: this.captureFailed },
        () => this.retry(),
      ),
    );
  }
}
