import { beforeEach, describe, expect, it } from 'vitest';

import { EDITOR_ROOT_ELEMENT_ID } from '../../common/index';
import { INPUT_STOP_REASON, InputStopController } from '../../webview/ui/input-stop';

interface Harness {
  readonly controller: InputStopController;
  /** The editor root. Returns `undefined` when it has not been created yet. */
  readonly readRoot: () => HTMLElement | undefined;
  /** Creates and places the editor root, making it editable just as a mount does. */
  readonly mount: () => HTMLElement;
}

/** Builds the input stop controller so that the editor root can be created afterwards. */
function createHarness(): Harness {
  document.body.replaceChildren();
  let root: HTMLElement | undefined;
  return {
    controller: new InputStopController({
      readEditorRoot: () => root,
      hasViewFocus: () => true,
      deferReturn: () => undefined,
      notifyResumed: () => undefined,
    }),
    readRoot: () => root,
    mount: () => {
      const created = root ?? document.createElement('div');
      created.id = EDITOR_ROOT_ELEMENT_ID;
      created.contentEditable = 'true';
      document.body.append(created);
      root = created;
      return created;
    },
  };
}

describe('the set of input stop reasons', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('makes the editor root non-editable when the first reason is added to an empty set', () => {
    const harness = createHarness();
    const root = harness.mount();

    harness.controller.add(INPUT_STOP_REASON.saveRoundTrip);

    expect(root.contentEditable).toBe('false');
  });

  it('makes the editor root non-editable while the reason of a PDF export is added', () => {
    const harness = createHarness();
    const root = harness.mount();

    harness.controller.add(INPUT_STOP_REASON.pdfExport);

    expect(root.contentEditable).toBe('false');
  });

  it('stays non-editable when two reasons are added and one is removed', () => {
    const harness = createHarness();
    const root = harness.mount();
    harness.controller.add(INPUT_STOP_REASON.saveRoundTrip);
    harness.controller.add(INPUT_STOP_REASON.historyProtected);

    harness.controller.remove(INPUT_STOP_REASON.saveRoundTrip);

    expect(root.contentEditable).toBe('false');
  });

  it('becomes editable again when the remaining reason is removed', () => {
    const harness = createHarness();
    const root = harness.mount();
    harness.controller.add(INPUT_STOP_REASON.saveRoundTrip);
    harness.controller.add(INPUT_STOP_REASON.historyProtected);
    harness.controller.remove(INPUT_STOP_REASON.saveRoundTrip);

    harness.controller.remove(INPUT_STOP_REASON.historyProtected);

    expect(root.contentEditable).toBe('true');
  });

  it('becomes editable again after a single removal even when the same reason was added twice', () => {
    const harness = createHarness();
    const root = harness.mount();

    harness.controller.add(INPUT_STOP_REASON.saveRoundTrip);
    harness.controller.add(INPUT_STOP_REASON.saveRoundTrip);
    harness.controller.remove(INPUT_STOP_REASON.saveRoundTrip);

    expect(root.contentEditable).toBe('true');
  });

  it('leaves editability unchanged when a reason that is not held is removed', () => {
    const harness = createHarness();
    const root = harness.mount();
    harness.controller.add(INPUT_STOP_REASON.saveRoundTrip);

    harness.controller.remove(INPUT_STOP_REASON.restoreIncomplete);

    expect(root.contentEditable).toBe('false');
  });

  it('throws nothing when a reason is added before the editor root exists, and stops it on the completed mount', () => {
    const harness = createHarness();

    harness.controller.add(INPUT_STOP_REASON.historyProtected);
    const root = harness.mount();
    harness.controller.handleMountCompleted(root);

    expect(root.contentEditable).toBe('false');
  });

  it('stays editable when a completed mount arrives while the set is empty', () => {
    const harness = createHarness();
    const root = harness.mount();

    harness.controller.handleMountCompleted(root);

    expect(root.contentEditable).toBe('true');
  });
});

describe('querying the reasons that remain', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('reports stopped while at least one reason remains', () => {
    const harness = createHarness();
    harness.mount();

    harness.controller.add(INPUT_STOP_REASON.actionDialog);

    expect(harness.controller.isStopped()).toBe(true);
  });

  it('reports no other reason when only the reason not counted remains', () => {
    const harness = createHarness();
    harness.mount();
    harness.controller.add(INPUT_STOP_REASON.actionDialog);

    expect(harness.controller.hasOtherReason(INPUT_STOP_REASON.actionDialog)).toBe(false);
  });

  it('reports another reason when an overlay reason remains besides the one not counted', () => {
    const harness = createHarness();
    harness.mount();
    harness.controller.add(INPUT_STOP_REASON.actionDialog);
    harness.controller.add(INPUT_STOP_REASON.saveRoundTrip);

    expect(harness.controller.hasOtherReason(INPUT_STOP_REASON.actionDialog)).toBe(true);
  });
});
