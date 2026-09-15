import { afterEach, describe, expect, it, vi } from 'vitest';
import { AhveDocument } from '../../src/editor/AhveDocument';

// `AhveDocument` imports `vscode` for types only, so it can be driven with a fake
// panel. Only `webview.postMessage` is exercised here.

type Panel = NonNullable<AhveDocument['panel']>;

function fakeUri(): AhveDocument['uri'] {
  return { fsPath: '/w/a.html', toString: () => 'file:///w/a.html' } as unknown as AhveDocument['uri'];
}

function fakePanel() {
  const postMessage = vi.fn(() => Promise.resolve(true));
  return { panel: { webview: { postMessage } } as unknown as Panel, postMessage };
}

function newDocument(): { document: AhveDocument; postMessage: ReturnType<typeof vi.fn> } {
  const { panel, postMessage } = fakePanel();
  const document = new AhveDocument(fakeUri(), undefined);
  document.panel = panel;
  document.resetViewReady();
  return { document, postMessage };
}

/** Lets the promise chain inside `postWhenViewReady` run to completion. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe('AhveDocument: view readiness gate', () => {
  it('holds a message back until the view is ready', async () => {
    const { document, postMessage } = newDocument();

    expect(document.postWhenViewReady({ type: 'testSetHtml', html: '<p>x</p>' })).toBe(true);
    await settle();
    expect(postMessage).not.toHaveBeenCalled();

    document.markViewReady();
    await settle();
    expect(postMessage).toHaveBeenCalledWith({ type: 'testSetHtml', html: '<p>x</p>' });
  });

  it('posts a message sent after the view is already ready', async () => {
    const { document, postMessage } = newDocument();
    document.markViewReady();

    document.postWhenViewReady({ type: 'testRequestSave' });
    await settle();

    expect(postMessage).toHaveBeenCalledWith({ type: 'testRequestSave' });
  });

  it('reports no live panel and posts nothing when the document has no panel', async () => {
    const document = new AhveDocument(fakeUri(), undefined);

    expect(document.postWhenViewReady({ type: 'testRequestSave' })).toBe(false);
    await settle();
  });

  it('does not post into a panel that was disposed while the gate was closed', async () => {
    const { document, postMessage } = newDocument();

    document.postWhenViewReady({ type: 'testSetHtml', html: '<p>x</p>' });
    document.dispose();
    await settle();

    expect(postMessage).not.toHaveBeenCalled();
  });

  it('re-arms the gate when a panel is resolved again', async () => {
    const { document, postMessage } = newDocument();
    document.markViewReady();

    // A moved or reloaded panel gets a fresh webview, which redoes the handshake.
    document.resetViewReady();
    document.postWhenViewReady({ type: 'testSetHtml', html: '<p>x</p>' });
    await settle();
    expect(postMessage).not.toHaveBeenCalled();

    document.markViewReady();
    await settle();
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  it('gives up on the handshake after the timeout instead of waiting forever', async () => {
    vi.useFakeTimers();
    const { document } = newDocument();

    const waited = vi.fn();
    void document.whenViewReady(500).then(waited);
    await vi.advanceTimersByTimeAsync(499);
    expect(waited).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(waited).toHaveBeenCalled();
  });

  it('resolves immediately when there is no view to wait for', async () => {
    const document = new AhveDocument(fakeUri(), undefined);

    const waited = vi.fn();
    void document.whenViewReady().then(waited);
    await settle();

    expect(waited).toHaveBeenCalled();
  });
});
