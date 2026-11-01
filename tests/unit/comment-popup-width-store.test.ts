// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { COMMENT_POPUP_MIN_WIDTH } from '../../common/index';
import { CommentPopupWidthStore } from '../../src/editor/comment-popup-width-store';

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

describe('the comment popup width store', () => {
  it('reads no width while nothing is stored, so that the default width applies', () => {
    expect(new CommentPopupWidthStore(createState()).read()).toBeUndefined();
  });

  it('reads back the width it stored, so that a store over the same state reads it too', async () => {
    const state = createState();

    await new CommentPopupWidthStore(state).write(360);

    expect(new CommentPopupWidthStore(state).read()).toBe(360);
  });

  it('reads the width it was given at once, while the global state still returns the previous one', () => {
    const state = createState({ commentPopupWidth: 300 });
    // VS Code's global state can go on returning the previous value until the write settles.
    const deferred = { get: state.get, update: (): Promise<void> => new Promise<void>(() => undefined) };
    const store = new CommentPopupWidthStore(deferred);

    void store.write(420);

    expect([store.read(), state.values.get('commentPopupWidth')]).toEqual([420, 300]);
  });

  it('goes on reading the width it wrote while the global state returns the value it replaced, even after the write settles', async () => {
    const state = createState({ commentPopupWidth: 300 });
    // The write settles, but the global state still returns the value from before it for a while.
    const lagging = { get: state.get, update: (): Promise<void> => Promise.resolve() };
    const store = new CommentPopupWidthStore(lagging);

    await store.write(420);

    expect(store.read()).toBe(420);
  });

  it('reads a width another window stores afterwards', async () => {
    const state = createState();
    const store = new CommentPopupWidthStore(state);
    await store.write(360);

    // Stands for another window storing its width into the same global state.
    state.values.set('commentPopupWidth', 420);

    expect(store.read()).toBe(420);
  });

  it('reads the width another window puts back to the one before the write, once the global state has returned the written one', async () => {
    const state = createState({ commentPopupWidth: 300 });
    const store = new CommentPopupWidthStore(state);
    await store.write(420);

    // Stands for another window going back to the width this one replaced.
    state.values.set('commentPopupWidth', 300);

    expect(store.read()).toBe(300);
  });

  it('replaces the width stored before', async () => {
    const store = new CommentPopupWidthStore(createState());

    await store.write(360);
    await store.write(420);

    expect(store.read()).toBe(420);
  });

  it('reads no width from a stored value that is not a number, and raises a stored width below the floor to it', () => {
    const malformed = new CommentPopupWidthStore(createState({ commentPopupWidth: '360' })).read();
    const narrow = new CommentPopupWidthStore(createState({ commentPopupWidth: 100 })).read();

    expect([malformed, narrow]).toEqual([undefined, COMMENT_POPUP_MIN_WIDTH]);
  });
});
