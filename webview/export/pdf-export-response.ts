import { PDF_EXPORT_REFUSAL, VIEW_TO_HOST_MESSAGE_TYPE } from '../../common/index';
import type { PdfExportRefusal, PdfExportResponseMessage, PdfPageImage, RequestId } from '../../common/index';
import { readChanges } from '../editing/change-read';
import { renderPdfPages } from './pdf-pages';
import type { PdfPagePorts } from './pdf-pages';

/** Ports of the responder to PDF export requests. */
export interface PdfExportResponderPorts extends PdfPagePorts {
  /** Returns the editor root, or `undefined` when no body is shown. */
  readEditorRoot(): HTMLElement | undefined;

  /** Returns how many times the document has been replaced since the view started. */
  readReplacementCount(): number;

  /** Stops the editing while the PDF is drawn. */
  stopInput(): void;

  /** Lets the editing go on again. */
  resumeInput(): void;

  /**
   * Sends the response to the host.
   *
   * @param response The PDF export response.
   * @throws When it cannot be sent.
   */
  post(response: PdfExportResponseMessage): void;

  /**
   * Leaves a diagnostic line for maintainers.
   *
   * @param detail The line.
   */
  reportDiagnostic(detail: string): void;
}

/**
 * Answers PDF export requests one at a time.
 *
 * Requests are queued, because the editing is stopped for the length of one export, and two exports overlapping
 * would let the first one start the editing again while the second is still drawing.
 */
export class PdfExportResponder {
  private queue: Promise<void> = Promise.resolve();

  /**
   * @param ports Ports of the responder.
   */
  constructor(private readonly ports: PdfExportResponderPorts) {}

  /**
   * Draws the pages of the PDF and sends them to the host, after the requests before it are answered.
   *
   * Never rejects. When no body is shown, the drawing fails, or the document is replaced while it is drawn, the
   * response carries `null`, so the host can report the failure without waiting for the timeout. A document that still
   * has change marks is declined without stopping the editing: a PDF is meant to be shared, and pending changes would
   * go out as if they were decided.
   *
   * @param requestId The request id of the request being answered.
   * @returns Resolves once the response has been sent and the editing goes on again.
   */
  respond(requestId: RequestId): Promise<void> {
    const answered = this.queue.then(() => this.answer(requestId));
    this.queue = answered;
    return answered;
  }

  private async answer(requestId: RequestId): Promise<void> {
    const root = this.ports.readEditorRoot();
    if (root === undefined) {
      this.send(requestId, null, null);
      return;
    }
    if (readChanges(root).length > 0) {
      this.send(requestId, null, PDF_EXPORT_REFUSAL.changeMarks);
      return;
    }

    // Stopping the editing does not stop the host from replacing the document, for example to take in a change on disk.
    // The page breaks are measured once, so pages drawn from a replaced tree would not line up with them.
    const replacements = this.ports.readReplacementCount();
    this.ports.stopInput();
    try {
      let pages: PdfPageImage[] | null = null;
      try {
        const drawn = await renderPdfPages(root, this.ports);
        if (this.ports.readReplacementCount() === replacements) {
          pages = drawn;
        } else {
          this.ports.reportDiagnostic('Could not draw the PDF because the document was replaced while it was drawn');
        }
      } catch (error) {
        this.ports.reportDiagnostic(`Could not draw the PDF: ${String(error)}`);
      }
      this.send(requestId, pages, null);
    } finally {
      this.ports.resumeInput();
    }
  }

  private send(requestId: RequestId, pages: PdfPageImage[] | null, refusal: PdfExportRefusal | null): void {
    try {
      this.ports.post({ type: VIEW_TO_HOST_MESSAGE_TYPE.pdfExportResponse, requestId, pages, refusal });
    } catch (error) {
      this.ports.reportDiagnostic(`Could not send the PDF export response: ${String(error)}`);
    }
  }
}
