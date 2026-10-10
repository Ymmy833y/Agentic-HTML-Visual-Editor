import { describe, expect, it } from 'vitest';

import { SerializationState } from '../../webview/document/serialization-state';

function parse(html: string): DocumentFragment {
  const template = document.createElement('template');
  template.innerHTML = html;
  return template.content;
}

function createRoot(html: string): HTMLElement {
  const root = document.createElement('div');
  root.append(parse(html));
  return root;
}

describe('serialization state', () => {
  it('leaves the disk body unchanged down to the character when there is no edit', () => {
    const disk = '<img src="a.png"/>\n<p>a</p>';
    const mounted = parse('<img src="a.png">\n<p>a</p>');
    const state = SerializationState.create(createRoot('<img src="a.png">\n<p>a</p>'), disk, mounted);

    expect(state.createBodyOutput().body).toBe(disk);
  });

  it('changes neither the result nor the live tree when the output is built twice', () => {
    const body = '<p>a</p>\n<p>b</p>';
    const root = createRoot(body);
    const state = SerializationState.create(root, body, parse(body));
    const before = root.innerHTML;

    const first = state.createBodyOutput();
    const second = state.createBodyOutput();

    expect(second).toEqual(first);
    expect(root.innerHTML).toBe(before);
  });

  it('replaces only the edited line when one line is edited', () => {
    const disk = '<img src="a.png"/>\n<p>a</p>';
    const baseline = '<img src="a.png">\n<p>a</p>';
    const root = createRoot(baseline);
    const state = SerializationState.create(root, disk, parse(baseline));
    const paragraph = root.querySelector('p');
    if (paragraph === null) {
      throw new Error('Could not create the paragraph for the test');
    }
    paragraph.textContent = 'b';

    expect(state.createBodyOutput().body).toBe('<img src="a.png"/>\n<p>b</p>');
  });

  it('builds the baseline from the tree before mounting, excluding elements added only after it', () => {
    const mounted = parse('<p>a</p>');
    const root = createRoot('<p>a</p><span data-ui="true"></span>');
    const state = SerializationState.create(root, '<p>a</p>', mounted);

    expect(state.createBodyOutput().body).toBe('<p>a</p><span data-ui="true"></span>');
  });

  it('replaces the state on commit so that the next output is based on the new body', () => {
    const root = createRoot('<p>a</p>');
    const state = SerializationState.create(root, '<p>a</p>', parse('<p>a</p>'));
    root.querySelector('p')!.textContent = 'b';
    const output = state.createBodyOutput();

    state.commit(output.body, output.current);

    expect(state.createBodyOutput().body).toBe('<p>b</p>');
  });

  it('takes only the given current form as the baseline and does not absorb edits made afterwards', () => {
    const root = createRoot('<p>a</p>');
    const state = SerializationState.create(root, '<p>a</p>', parse('<p>a</p>'));
    root.querySelector('p')!.textContent = 'b';
    const output = state.createBodyOutput();
    root.querySelector('p')!.textContent = 'c';

    state.commit(output.body, output.current);

    expect(state.createBodyOutput().body).toBe('<p>c</p>');
  });

  it('creates the body from the supplied current form without reading later live-tree changes', () => {
    const root = createRoot('<p>a</p>');
    const state = SerializationState.create(root, '<p>a</p>', parse('<p>a</p>'));
    const current = state.createBodyOutput().current;
    root.querySelector('p')!.textContent = 'b';

    expect(state.createBodyOutputFromCurrent(current)).toEqual({
      body: '<p>a</p>',
      current: '<p>a</p>',
    });
  });

  it('reports no uncommitted edits for a tree immediately after mounting', () => {
    const root = createRoot('<p>a</p>');
    const state = SerializationState.create(root, '<p>a</p>', parse('<p>a</p>'));

    expect(state.hasUncommittedEdits()).toBe(false);
  });

  it('reports uncommitted edits after changing the tree and none after replacing the baseline', () => {
    const root = createRoot('<p>a</p>');
    const state = SerializationState.create(root, '<p>a</p>', parse('<p>a</p>'));
    root.querySelector('p')!.textContent = 'b';
    const edited = state.hasUncommittedEdits();
    const output = state.createBodyOutput();

    state.commit(output.body, output.current);

    expect([edited, state.hasUncommittedEdits()]).toEqual([true, false]);
  });

  it('produces a matching output when the output is loaded again and output once more', () => {
    const disk = '<img src="a.png"/>\n<p>a</p>';
    const root = createRoot('<img src="a.png">\n<p>a</p>');
    const state = SerializationState.create(root, disk, parse('<img src="a.png">\n<p>a</p>'));
    root.querySelector('p')!.textContent = 'b';
    const output = state.createBodyOutput();

    // Start over by turning the output back into a tree as the disk body. Merely
    // setting the same current form as the new baseline would pass without ever
    // checking whether the spelling stays stable through parsing.
    const reloadedRoot = createRoot(output.body);
    const reloaded = SerializationState.create(reloadedRoot, output.body, parse(output.body));

    expect(reloaded.createBodyOutput().body).toBe(output.body);
  });
});
