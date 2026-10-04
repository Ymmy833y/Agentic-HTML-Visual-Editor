/**
 * The narrowest width, in CSS pixels, that the sidebar can be dragged to. The bundled stylesheet spells the same
 * value, so that the default width obeys the same floor.
 */
export const SIDEBAR_MIN_WIDTH = 160;

/**
 * The names of the meta elements through which the host hands the last sidebar layout to a view it creates.
 *
 * The layout is shared by every file, while the view of one file cannot read what another view stored, so the host
 * keeps it and writes it into each new view's document.
 */
export const SIDEBAR_LAYOUT_META_NAME = {
  open: 'ahve-sidebar-open',
  width: 'ahve-sidebar-width',
} as const;

/** Whether the sidebar is open and how wide the user made it. */
export interface SidebarLayout {
  /** Whether the sidebar is open. */
  readonly open: boolean;
  /**
   * The width in CSS pixels, never below {@link SIDEBAR_MIN_WIDTH}. `undefined` until the user first drags the edge,
   * in which case the stylesheet's default width applies.
   */
  readonly width?: number;
}

/**
 * A change to the layout made in one view: whether the sidebar is open, its width, or both.
 *
 * A view sends only what the user changed, so that the other half stays as another view last stored it rather than
 * being overwritten with this view's older value.
 */
export interface SidebarLayoutChange {
  /** Whether the sidebar is open. Absent when only the width changed. */
  readonly open?: boolean;
  /** The width in CSS pixels. Absent when only the open state changed. */
  readonly width?: number;
}

/** The layout used when none has been stored: closed, with the default width. */
export const DEFAULT_SIDEBAR_LAYOUT: SidebarLayout = { open: false };

/**
 * Reads a sidebar layout from a value of unknown shape.
 *
 * Both the stored state and the document the view reads it from can hold any value at runtime. A width below the floor
 * is raised to it rather than rejected, so that a layout stored under a smaller floor still opens at a usable width.
 *
 * @param value The value to read.
 * @returns The layout with a whole-pixel width, or `undefined` when the value is not one.
 */
export function parseSidebarLayout(value: unknown): SidebarLayout | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const { open, width } = value as { readonly open?: unknown; readonly width?: unknown };
  if (typeof open !== 'boolean') {
    return undefined;
  }
  if (width === undefined) {
    return { open };
  }
  if (typeof width !== 'number' || !Number.isFinite(width)) {
    return undefined;
  }
  return { open, width: Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)) };
}
