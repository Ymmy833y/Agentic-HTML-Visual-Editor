// @vitest-environment node
import { describe, expect, it } from 'vitest';

import type * as vscode from 'vscode';

import { WebviewInspectionRecorder } from '../../src/testing/webview-inspection';

/**
 * Creates a panel that carries only the webview options and the icons the observation point reads.
 *
 * @param html The HTML left in the record.
 */
function createPanel(html: string): vscode.WebviewPanel {
  const panel = {
    webview: {
      html,
      options: {
        enableScripts: true,
        enableCommandUris: false,
        enableForms: false,
        localResourceRoots: [],
      },
    },
    iconPath: undefined,
  };

  // The observation point reads nothing beyond the webview options and the icons above, so this
  // minimal shape is safe in a unit test that does not launch VS Code.
  return panel as unknown as vscode.WebviewPanel;
}

describe('webview inspection recording', () => {
  it('records no panel options and reports no target when constructed as disabled', () => {
    const recorder = new WebviewInspectionRecorder(false);

    recorder.record(createUri('file:///first.html'), createPanel('<main>first</main>'));

    expect(recorder.read('file:///first.html')).toBeUndefined();
  });

  it('does not record the messages sent and received when constructed as disabled', () => {
    const recorder = new WebviewInspectionRecorder(false);
    const uri = createUri('file:///first.html');

    recorder.record(uri, createPanel('<main>first</main>'));
    recorder.recordMessage(uri, 'fromView', { type: 'viewReady' });

    expect(recorder.read(uri.toString())).toBeUndefined();
  });

  it('does not record source change triggers when constructed as disabled', () => {
    const recorder = new WebviewInspectionRecorder(false);
    const uri = createUri('file:///first.html');

    recorder.record(uri, createPanel('<main>first</main>'));
    recorder.recordSourceChangeTrigger(uri, 'fileChange');

    expect(recorder.read(uri.toString())).toBeUndefined();
  });

  it('exposes only the most recent panel when constructed as enabled', () => {
    const recorder = new WebviewInspectionRecorder(true);
    const first = createUri('file:///first.html');
    const second = createUri('file:///second.html');
    recorder.record(first, createPanel('<main>first</main>'));
    recorder.recordMessage(first, 'fromView', { type: 'viewReady' });
    recorder.recordSourceChangeTrigger(first, 'fileChange');

    recorder.record(second, createPanel('<main>second</main>'));

    expect(recorder.read(first.toString())).toBeUndefined();
    expect(recorder.read(second.toString())).toMatchObject({
      html: '<main>second</main>',
      messages: [],
      sourceChangeTriggers: [],
    });
  });
});

/**
 * Creates a URI that carries only the string representation the observation point uses.
 *
 * @param value The string representation of the URI.
 */
function createUri(value: string): vscode.Uri {
  const uri = { toString: (): string => value };
  // The observation point reads nothing beyond the string representation, so this minimal shape
  // produces the same result as VS Code's URI.
  return uri as unknown as vscode.Uri;
}
