// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { SIDEBAR_MIN_WIDTH } from '../../common/index';
import { SidebarLayoutStore, parseSidebarLayoutChange } from '../../src/editor/sidebar-layout-store';

/**
 * Creates a stand-in for the global state that keeps values in a map.
 *
 * @param initial The value stored under each key from the start.
 */
function createState(initial: Record<string, unknown> = {}): {
  readonly values: Map<string, unknown>;
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Promise<void>;
} {
  const values = new Map<string, unknown>(Object.entries(initial));
  return {
    values,
    get: <T>(key: string): T | undefined => values.get(key) as T | undefined,
    update: (key, value) => {
      values.set(key, value);
      return Promise.resolve();
    },
  };
}

describe('the sidebar layout store', () => {
  it('reads closed with the default width while nothing is stored', () => {
    expect(new SidebarLayoutStore(createState()).read()).toEqual({ open: false });
  });

  it('reads back the layout it stored, so that a store over the same state reads it too', async () => {
    const state = createState();

    await new SidebarLayoutStore(state).write({ open: true, width: 260 });

    expect(new SidebarLayoutStore(state).read()).toEqual({ open: true, width: 260 });
  });

  it('lays a change of the open state over the stored width, and a change of the width over the stored open state', async () => {
    const state = createState();
    const store = new SidebarLayoutStore(state);
    await store.write({ open: true, width: 400 });

    await store.write({ open: false });
    const afterClosing = store.read();
    await store.write({ width: 300 });

    expect([afterClosing, store.read()]).toEqual([{ open: false, width: 400 }, { open: false, width: 300 }]);
  });

  it('lays a change over the one before it while the global state still returns the previous layout', () => {
    const state = createState({ sidebarLayout: { open: false } });
    const written: unknown[] = [];
    // VS Code's global state can go on returning the previous value until the write settles.
    const deferred = {
      get: state.get,
      update: (_key: string, value: unknown): Promise<void> => {
        written.push(value);
        return new Promise<void>(() => undefined);
      },
    };
    const store = new SidebarLayoutStore(deferred);

    void store.write({ width: 300 });
    void store.write({ open: true });

    expect([store.read(), written]).toEqual([
      { open: true, width: 300 },
      [{ open: false, width: 300 }, { open: true, width: 300 }],
    ]);
  });

  it('goes on reading the layout it wrote while the global state returns the value it replaced, even after the write settles', async () => {
    const state = createState({ sidebarLayout: { open: false } });
    // The write settles, but the global state still returns the value from before it for a while.
    const lagging = { get: state.get, update: (): Promise<void> => Promise.resolve() };
    const store = new SidebarLayoutStore(lagging);

    await store.write({ width: 300 });

    expect(store.read()).toEqual({ open: false, width: 300 });
  });

  it('reads a layout another window stores afterwards', async () => {
    const state = createState();
    const store = new SidebarLayoutStore(state);
    await store.write({ open: true });

    // Stands for another window storing its layout into the same global state.
    state.values.set('sidebarLayout', { open: false, width: 500 });

    expect(store.read()).toEqual({ open: false, width: 500 });
  });

  it('reads the layout another window puts back to the one before the write, once the global state has returned the written one', async () => {
    const state = createState({ sidebarLayout: { open: false } });
    const store = new SidebarLayoutStore(state);
    await store.write({ open: true });

    // Stands for another window closing the sidebar this one opened.
    state.values.set('sidebarLayout', { open: false });

    expect(store.read()).toEqual({ open: false });
  });

  it('stores only the open state when there is no width', async () => {
    const state = createState();

    await new SidebarLayoutStore(state).write({ open: true });

    expect([...state.values.values()]).toEqual([{ open: true }]);
  });

  it('reads the default for a stored value that is not a layout, and raises a stored width below the narrowest width', async () => {
    const state = createState();
    const store = new SidebarLayoutStore(state);
    await store.write({ open: true, width: 300 });
    const key = [...state.values.keys()][0];

    state.values.set(key, { open: 'yes' });
    const malformed = store.read();
    state.values.set(key, { open: true, width: 10 });

    expect([malformed, store.read()]).toEqual([{ open: false }, { open: true, width: SIDEBAR_MIN_WIDTH }]);
  });
});

describe('reading a sidebar layout change', () => {
  it('reads the open state alone, the width alone, and both, bounding the width as in a stored layout', () => {
    expect([
      parseSidebarLayoutChange({ open: false }),
      parseSidebarLayoutChange({ width: 250.4 }),
      parseSidebarLayoutChange({ width: 10 }),
      parseSidebarLayoutChange({ open: true, width: 300, extra: 'x' }),
    ]).toEqual([{ open: false }, { width: 250 }, { width: SIDEBAR_MIN_WIDTH }, { open: true, width: 300 }]);
  });

  it('rejects a value that is not an object, a change carrying neither field, and a field of the wrong type', () => {
    expect([
      parseSidebarLayoutChange(null),
      parseSidebarLayoutChange('open'),
      parseSidebarLayoutChange({}),
      parseSidebarLayoutChange({ open: 'true' }),
      parseSidebarLayoutChange({ width: '240' }),
      parseSidebarLayoutChange({ open: true, width: Number.NaN }),
    ]).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
  });
});
