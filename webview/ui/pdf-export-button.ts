import { VIEW_TO_HOST_MESSAGE_TYPE } from '../../common/index';
import type { HostChannel } from '../messaging/host-channel';
import type { Toolbar } from './toolbar';
import { TOOLBAR_SLOT } from './toolbar-slots';

/**
 * Icon representing exporting the document as a PDF.
 *
 * Draws a page with a folded corner and an arrow pointing down out of it in a single path on a 24×24 viewBox. Like the
 * other toolbar icons, it has no color of its own and is drawn in the toolbar foreground color.
 */
export const PDF_EXPORT_ICON_PATH = 'M13 3H6v18h12V8z M13 3v5h5 M12 11v7 M9 15l3 3 3-3';

/**
 * Registers an item in the toolbar's export slot that runs an action when pressed.
 *
 * No pressed state is passed, because this item does not represent any current state. It stays pressable even while
 * the document has change marks: the host tells why nothing was exported, the same as for the command, and the view
 * need not track the marks to keep the button up to date. The action is called through the toolbar activation, so it
 * is not called during an input stop or during composition.
 *
 * @param toolbar The toolbar to register with.
 * @param run The action to call when pressed.
 */
export function registerPdfExportButton(toolbar: Toolbar, run: () => void): void {
  toolbar.register(TOOLBAR_SLOT.pdfExport, {
    kind: 'button',
    messageKey: 'toolbar.exportAsPdf',
    iconPath: PDF_EXPORT_ICON_PATH,
    run,
  });
}

/**
 * Sends the export requested message to the host.
 *
 * Carries no content. The host decides which document to export from the panel that receives it, and draws the PDF
 * through a request PDF export message, as the command does.
 *
 * @param channel The host channel.
 * @param reportDiagnostic Leaves a diagnostic line when the message cannot be sent.
 */
export function requestPdfExport(channel: HostChannel, reportDiagnostic: (detail: string) => void): void {
  try {
    channel.post({ type: VIEW_TO_HOST_MESSAGE_TYPE.pdfExportRequested });
  } catch (error) {
    reportDiagnostic(`Could not send the PDF export request: ${String(error)}`);
  }
}
