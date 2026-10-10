import type * as vscode from 'vscode';

/**
 * A snapshot of the settings applied to a webview panel.
 *
 * VS Code does not expose webview panels outside the extension, so the extension must provide an
 * observation point for integration tests to verify what it applied. This code exists solely for
 * testing and exposes only a snapshot of the settings, not the panel itself.
 */
export interface WebviewInspection {
  readonly html: string;
  readonly enableScripts: boolean;
  readonly enableCommandUris: boolean;
  readonly enableForms: boolean;
  readonly localResourceRoots: readonly string[];
  /** The tab icons given to the panel, or `undefined` when none were given. */
  readonly iconPath: TabIconInspection | undefined;
  /** Messages sent and received, in transmission order. */
  readonly messages: readonly RecordedMessage[];
  /** Source change triggers passed to reconciliation, in the order received. */
  readonly sourceChangeTriggers: readonly SourceChangeTriggerInspection[];
}

/** The tab icons of a panel, as the URI strings used under light and dark themes. */
export interface TabIconInspection {
  readonly light: string;
  readonly dark: string;
}

/** Source change trigger observed by integration tests. */
export type SourceChangeTriggerInspection = 'textBufferChange' | 'fileChange';

/** The direction in which a message traveled. */
export type MessageDirection = 'fromView' | 'toView';

/** A sent or received message and its direction. */
export interface RecordedMessage {
  readonly direction: MessageDirection;
  // The record is only an observation point for assertions, so do not narrow it to the contract
  // type. Preserving messages whose types are outside the contract lets tests verify more behavior.
  readonly message: unknown;
}

interface RecordedPanel {
  readonly documentUri: string;
  readonly settings: Omit<WebviewInspection, 'messages' | 'sourceChangeTriggers'>;
  readonly messages: RecordedMessage[];
  readonly sourceChangeTriggers: SourceChangeTriggerInspection[];
}

/** Stores the settings for the most recently configured panel. */
export class WebviewInspectionRecorder {
  private latest: RecordedPanel | undefined;

  constructor(private readonly enabled: boolean) {}

  /**
   * Takes a snapshot of the settings applied to a panel and stores only that entry.
   *
   * @param documentUri The URI of the target file.
   * @param panel The panel after all its settings have been applied.
   */
  record(documentUri: vscode.Uri, panel: vscode.WebviewPanel): void {
    if (!this.enabled) {
      return;
    }

    const webview = panel.webview;
    const options = webview.options;
    // enableCommandUris accepts either a boolean or an array of allowed commands. The snapshot needs
    // to record whether any command is allowed, so an array is evaluated by whether it has entries.
    const commandUris = options.enableCommandUris;

    this.latest = {
      documentUri: documentUri.toString(),
      // Do not retain the previous panel's record. Recreating the panel also recreates the view, so
      // earlier exchanges do not represent the behavior of the current panel.
      messages: [],
      sourceChangeTriggers: [],
      settings: {
        html: webview.html,
        enableScripts: options.enableScripts === true,
        enableCommandUris: typeof commandUris === 'boolean' ? commandUris : (commandUris?.length ?? 0) > 0,
        enableForms: options.enableForms === true,
        localResourceRoots: (options.localResourceRoots ?? []).map((root) => root.toString()),
        iconPath: readTabIcon(panel.iconPath),
      },
    };
  }

  /**
   * Appends a message sent to or received from the panel, together with its direction, to the record.
   *
   * @param documentUri The URI of the target file.
   * @param direction The direction in which the message traveled.
   * @param message The message that was sent or received.
   */
  recordMessage(documentUri: vscode.Uri, direction: MessageDirection, message: unknown): void {
    if (!this.enabled || this.latest?.documentUri !== documentUri.toString()) {
      return;
    }

    this.latest.messages.push({ direction, message });
  }

  /**
   * Records a source change trigger for the current panel after matching the target URI.
   *
   * @param documentUri URI of the target file.
   * @param trigger Trigger passed to reconciliation.
   */
  recordSourceChangeTrigger(
    documentUri: vscode.Uri,
    trigger: SourceChangeTriggerInspection,
  ): void {
    if (!this.enabled || this.latest?.documentUri !== documentUri.toString()) {
      return;
    }

    this.latest.sourceChangeTriggers.push(trigger);
  }

  /**
   * Returns the recorded settings for the specified file.
   *
   * @param documentUri The string representation of the target file's URI.
   * @returns The recorded settings, or `undefined` if the stored entry is for another file.
   */
  read(documentUri: string): WebviewInspection | undefined {
    if (this.latest?.documentUri !== documentUri) {
      return undefined;
    }

    // Return a snapshot so the received sequence remains unchanged if exchanges continue after the read.
    return {
      ...this.latest.settings,
      messages: [...this.latest.messages],
      sourceChangeTriggers: [...this.latest.sourceChangeTriggers],
    };
  }
}

/**
 * Converts the icons given to a panel into URI strings per theme kind.
 *
 * @param iconPath The panel's icons.
 * @returns The icons, or `undefined` when the panel has none.
 */
function readTabIcon(iconPath: vscode.WebviewPanel['iconPath']): TabIconInspection | undefined {
  if (iconPath === undefined) {
    return undefined;
  }
  if ('light' in iconPath) {
    return { light: iconPath.light.toString(), dark: iconPath.dark.toString() };
  }
  // VS Code shows a single icon under both theme kinds, so it is recorded under both.
  return { light: iconPath.toString(), dark: iconPath.toString() };
}
