import { describe, expect, it } from 'vitest';
import { AhveSessionRegistry } from '../../src/editor/session-registry';
import type { AhveDocument } from '../../src/editor/AhveDocument';

// The registry imports `vscode` for types only, so it can be driven with minimal
// fakes. All it needs is a document's `uri` (toString / fsPath) and `panel` identity.

type FakePanel = { name: string };

function fakeUri(fsPath: string, text = `file://${fsPath}`): AhveDocument['uri'] {
  return { fsPath, toString: () => text } as unknown as AhveDocument['uri'];
}

function fakeDocument(uri: AhveDocument['uri'], panel?: FakePanel): AhveDocument {
  return { uri, panel } as unknown as AhveDocument;
}

function panel(name: string): FakePanel {
  return { name };
}

function asPanel(value: FakePanel): Parameters<AhveSessionRegistry['setActivePanel']>[0] {
  return value as unknown as Parameters<AhveSessionRegistry['setActivePanel']>[0];
}

describe('AhveSessionRegistry: document registration', () => {
  it('finds a registered document by the uri string representation', () => {
    const registry = new AhveSessionRegistry();
    const uri = fakeUri('/w/a.html');
    const document = fakeDocument(uri);
    registry.add(document);

    expect(registry.find(uri)).toBe(document);
  });

  it('falls back to fsPath when uri strings do not match', () => {
    // VSCode may normalize a uri before it reaches openCustomDocument (the case of a
    // Windows drive letter, for instance).
    const registry = new AhveSessionRegistry();
    const document = fakeDocument(fakeUri('/w/a.html', 'file:///W/a.html'));
    registry.add(document);

    expect(registry.find(fakeUri('/w/a.html', 'file:///w/a.html'))).toBe(document);
  });

  it('returns undefined for an unregistered uri', () => {
    const registry = new AhveSessionRegistry();
    registry.add(fakeDocument(fakeUri('/w/a.html')));

    expect(registry.find(fakeUri('/w/b.html'))).toBeUndefined();
  });

  it('removes a document only when it is still the registered instance', () => {
    const registry = new AhveSessionRegistry();
    const uri = fakeUri('/w/a.html');
    const first = fakeDocument(uri);
    const second = fakeDocument(uri);
    registry.add(first);
    registry.add(second); // reopened under the same uri

    // A late dispose of the old document must not erase the new registration.
    registry.remove(first);
    expect(registry.find(uri)).toBe(second);

    registry.remove(second);
    expect(registry.find(uri)).toBeUndefined();
  });
});

describe('AhveSessionRegistry: active panel', () => {
  it('starts with no active panel', () => {
    expect(new AhveSessionRegistry().getActivePanel()).toBeNull();
  });

  it('returns the most recently set panel', () => {
    const registry = new AhveSessionRegistry();
    const a = panel('a');
    const b = panel('b');
    registry.setActivePanel(asPanel(a));
    registry.setActivePanel(asPanel(b));

    expect(registry.getActivePanel()).toBe(b);
  });

  it('clears the active panel only when given the current panel', () => {
    const registry = new AhveSessionRegistry();
    const active = panel('active');
    const other = panel('other');
    registry.setActivePanel(asPanel(active));

    // Another panel going inactive must not lose track of the active one.
    registry.clearActivePanel(asPanel(other));
    expect(registry.getActivePanel()).toBe(active);

    registry.clearActivePanel(asPanel(active));
    expect(registry.getActivePanel()).toBeNull();
  });
});

describe('AhveSessionRegistry: active document', () => {
  it('returns the document hosted by the active panel', () => {
    const registry = new AhveSessionRegistry();
    const activePanel = panel('a');
    const target = fakeDocument(fakeUri('/w/a.html'), activePanel);
    registry.add(target);
    registry.add(fakeDocument(fakeUri('/w/b.html'), panel('b')));
    registry.setActivePanel(asPanel(activePanel));

    expect(registry.getActiveDocument()).toBe(target);
  });

  it('returns undefined when there is no active panel', () => {
    const registry = new AhveSessionRegistry();
    registry.add(fakeDocument(fakeUri('/w/a.html'), panel('a')));

    expect(registry.getActiveDocument()).toBeUndefined();
  });

  it('returns undefined when no document hosts the active panel', () => {
    const registry = new AhveSessionRegistry();
    registry.add(fakeDocument(fakeUri('/w/a.html'), panel('a')));
    registry.setActivePanel(asPanel(panel('detached')));

    expect(registry.getActiveDocument()).toBeUndefined();
  });
});
