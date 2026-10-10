import type { HostToViewMessage, ViewToHostMessage } from '../../common/index';

/** Channel for sending messages to the host. */
export interface HostChannel {
  /**
   * Sends a message to the host.
   *
   * @param message A message type that the view can send to the host.
   */
  post(message: ViewToHostMessage): void;
}

/** The subset of the API provided by VS Code to the view that is used here. */
interface VsCodeApi {
  postMessage(message: unknown): void;
}

/** The view window that provides `acquireVsCodeApi`. */
export interface WebviewWindow extends Window {
  acquireVsCodeApi?: () => VsCodeApi;
}

/**
 * Creates a channel for exchanging messages with the host.
 *
 * The VS Code API can be acquired only once, so only this file acquires it. Other files use the
 * returned channel.
 *
 * @param view The view window.
 * @param onMessage The function that receives messages from the host.
 * @returns The channel for sending messages to the host.
 */
export function createHostChannel(
  view: WebviewWindow,
  onMessage: (message: HostToViewMessage) => void,
): HostChannel {
  const acquire = view.acquireVsCodeApi;
  if (acquire === undefined) {
    throw new Error('Could not acquire the VS Code API. This code is running outside a webview.');
  }

  const api = acquire();

  // Register the receiver before returning the channel. If registration occurred after the caller
  // notified the host that the view was ready, the response could arrive before registration.
  //
  // Treat received values as the contract type. Only values sent by the host arrive through this path.
  view.addEventListener('message', (event: MessageEvent<HostToViewMessage>) => {
    onMessage(event.data);
  });

  return {
    post(message: ViewToHostMessage): void {
      api.postMessage(message);
    },
  };
}
