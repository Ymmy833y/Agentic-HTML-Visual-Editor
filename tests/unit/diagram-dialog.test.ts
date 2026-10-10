import { describe, expect, it } from 'vitest';

import { createLocalizer } from '../../common/index';
import type { ActionDialogResult, ActionDialogSpec } from '../../webview/ui/action-dialog';
import { buildDiagramDialogSpec, openDiagramDialog } from '../../webview/ui/diagram-dialog';
import type { DiagramDialogPorts } from '../../webview/ui/diagram-dialog';
import { mountRoot, readElement } from './helpers/format-dom';

// An empty catalog resolves every key to itself, which shows which message each place asks for.
const LOCALIZER = createLocalizer({});

/**
 * Creates the ports of the diagram dialog, answering the dialog with a fixed result and recording the edits asked for.
 *
 * @param root The editor root.
 * @param result The result the dialog returns.
 * @returns The ports, the specs the dialog was opened with and the edits asked for.
 */
function createPorts(
  root: Element,
  result: ActionDialogResult,
): { ports: DiagramDialogPorts; specs: ActionDialogSpec[]; calls: string[] } {
  const specs: ActionDialogSpec[] = [];
  const calls: string[] = [];
  const ports: DiagramDialogPorts = {
    readEditorRoot: () => root,
    isComposing: () => false,
    isInputStopped: () => false,
    openDialog: (spec) => {
      specs.push(spec);
      return Promise.resolve(result);
    },
    updateSource: (_block, source) => {
      calls.push(`update:${source}`);
      return true;
    },
    removeDiagram: () => {
      calls.push('remove');
      return true;
    },
    localizer: LOCALIZER,
    reportDiagnostic: () => undefined,
  };
  return { ports, specs, calls };
}

describe('the spec of the diagram dialog', () => {
  it('holds one multi-line field with the current source, the save, cancel and delete labels, and rejects an empty source', () => {
    const spec = buildDiagramDialogSpec(LOCALIZER, 'graph TD');

    expect([
      spec.fields,
      [spec.confirmLabel, spec.cancelLabel, spec.extraActionLabel],
      spec.validate?.({ source: ' \n ' }),
      spec.validate?.({ source: 'graph TD' }),
    ]).toEqual([
      [{ name: 'source', label: 'diagramDialog.source', initialValue: 'graph TD', multiline: true, required: true }],
      ['diagramDialog.save', 'diagramDialog.cancel', 'diagramDialog.delete'],
      'diagramDialog.sourceRequired',
      undefined,
    ]);
  });

  it('marks the source field as required and gives the requirement badge texts', () => {
    const spec = buildDiagramDialogSpec(LOCALIZER, 'graph TD');

    expect(spec.requirementLabels).toEqual({
      required: 'actionDialog.required',
      optional: 'actionDialog.optional',
    });
  });
});

describe('opening the diagram dialog', () => {
  it('rewrites the source without its trailing whitespace on save, removes the diagram on delete, and does nothing on cancel', async () => {
    const root = mountRoot('<pre class="mermaid">graph TD</pre>');
    const block = readElement(root, 'pre');
    const saved = createPorts(root, { confirmed: true, values: { source: 'graph LR\n\n' } });
    const deleted = createPorts(root, { confirmed: false, extraAction: true });
    const canceled = createPorts(root, { confirmed: false });

    await openDiagramDialog(saved.ports, block);
    await openDiagramDialog(deleted.ports, block);
    await openDiagramDialog(canceled.ports, block);

    expect([saved.specs[0]?.fields[0]?.initialValue, saved.calls, deleted.calls, canceled.calls])
      .toEqual(['graph TD', ['update:graph LR'], ['remove'], []]);
  });

  it('shows the source without its trailing line break, and puts the line break back on save so an untouched source stays the same', async () => {
    const root = mountRoot('<pre class="mermaid">graph TD\n  A --&gt; B\n</pre>');
    const block = readElement(root, 'pre');
    const untouched = createPorts(root, { confirmed: true, values: { source: 'graph TD\n  A --> B' } });
    const changed = createPorts(root, { confirmed: true, values: { source: 'graph LR\n  A --> B  \n' } });

    await openDiagramDialog(untouched.ports, block);
    await openDiagramDialog(changed.ports, block);

    expect([untouched.specs[0]?.fields[0]?.initialValue, untouched.calls, changed.calls]).toEqual([
      'graph TD\n  A --> B',
      ['update:graph TD\n  A --> B\n'],
      ['update:graph LR\n  A --> B\n'],
    ]);
  });
});
