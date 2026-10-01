// The stand-in for the extension host.
// It does only two things: record the messages sent to the host, and inject the messages that arrive
// from the host. It has no setState / getState (basic design §3.2).

// Message types stay unknown until F-06 defines them in common, so that the contract is not copied
// into the stub and maintained in two places.
export interface StubHost {
  // Holds the messages the webview sent to the host, in the order they were sent.
  readonly record: unknown[];
  // Passes a message to the webview as if it had arrived from the host. Counts as a success even when
  // nothing is listening.
  inject(message: unknown): void;
  // Makes sends to the host fail while set. Defaults to false.
  failSend: boolean;
  // Fail delivery only for the listed types. This lets paths that send multiple types in one operation, such as
  // unload, fail only one of them. Empty by default.
  failSendTypes: string[];
}

export interface VsCodeApi {
  postMessage(message: unknown): void;
}

declare global {
  interface Window {
    __stubHost?: StubHost;
    acquireVsCodeApi?: () => VsCodeApi;
  }
}

// This is evaluated on the browser side as the page's initialization script, so it cannot reference
// variables in module scope. Everything has to be contained in the function body (detailed design §3.6).
// If a stub is already installed, it is replaced together with its record.
//
// Keep as little logic as possible in helpers (testing policy §6). The two branches here exist only to
// reproduce the behavior of the real webview; leaving them out would diverge from the real environment.
export function installStubHost(): void {
  const record: unknown[] = [];
  // In a real webview, acquireVsCodeApi can be obtained only once.
  let acquired = false;

  const host: StubHost = {
    record,
    failSend: false,
    failSendTypes: [],
    inject(message: unknown): void {
      // Receiving from the real host goes through a structured clone. Values that cannot be cloned throw here.
      window.dispatchEvent(new MessageEvent('message', { data: structuredClone(message) }));
    },
  };
  window.__stubHost = host;

  window.acquireVsCodeApi = () => {
    if (acquired) {
      throw new Error('An instance of the VS Code API has already been acquired');
    }
    acquired = true;
    return {
      postMessage(message: unknown): void {
        // A send failure in the real environment is reported as a synchronous exception. The real
        // environment does not record failed sends either.
        const type = typeof message === 'object' && message !== null && 'type' in message
          ? String((message as { type: unknown }).type)
          : '';
        if (host.failSend || host.failSendTypes.includes(type)) {
          throw new Error('Failed to send to the host');
        }
        // Sending to the real host also goes through a structured clone. Cloning before recording
        // rejects values that cannot be cloned, and keeps the record unchanged even when the original
        // object is rewritten after it was sent.
        record.push(structuredClone(message));
      },
    };
  };
}
