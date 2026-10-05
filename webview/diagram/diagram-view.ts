import { EDITOR_ROOT_ELEMENT_ID } from '../../common/index';
import type { Localizer } from '../../common/index';
import { INTERNAL_ATTRIBUTE_NAMESPACE_PREFIX } from '../document/internal-attribute';
import { readSelectionRange } from '../editing/caret';
import type { EditingSession } from '../editing/editing-session';
import { findDiagramSources, readDiagramSource } from './diagram-source';
import { DIAGRAM_FAILURE, readDiagramTheme, renderDiagram } from './diagram-render';
import type { DiagramImage, DiagramRenderer, DiagramResult, DiagramTheme } from './diagram-render';

/** The internal namespace of the marks the diagram view puts on diagram source blocks. */
export const DIAGRAM_MARK_NAMESPACE = `${INTERNAL_ATTRIBUTE_NAMESPACE_PREFIX}diagram`;

/** The mark of every diagram source block. It hides the source and shows the diagram in its place. */
export const DIAGRAM_BLOCK_MARK_NAME = 'data-ahve-diagram-block';

/** The mark of a drawn diagram. Its value names the generated rule that draws the image. */
export const DIAGRAM_MARK_NAME = 'data-ahve-diagram';

/** The mark of a source that could not be drawn. */
export const DIAGRAM_ERROR_MARK_NAME = 'data-ahve-diagram-error';

/** The mark of a block whose source is empty. */
export const DIAGRAM_EMPTY_MARK_NAME = 'data-ahve-diagram-empty';

/** The mark of a diagram that a range selection wholly contains. */
export const DIAGRAM_SELECTED_MARK_NAME = 'data-ahve-diagram-selected';

/** The mark of a drawn diagram shown at a zoom level other than 100%. */
export const DIAGRAM_ZOOMED_MARK_NAME = 'data-ahve-diagram-zoomed';

/**
 * The zoom levels a diagram steps through, as factors of its usual size: the drawn size, or the column width for a
 * diagram wider than the column. Finer steps below 100% and coarser ones above keep each step a visible change.
 */
export const DIAGRAM_ZOOM_LEVELS: readonly number[] = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

/** The custom property on the page root that hands the error notice to the stylesheet. */
export const DIAGRAM_ERROR_LABEL_PROPERTY = '--ahve-diagram-error-label';

/** The custom property on the page root that hands the notice of an empty diagram to the stylesheet. */
export const DIAGRAM_EMPTY_LABEL_PROPERTY = '--ahve-diagram-empty-label';

/** The id of the element diagrams are laid out in while Mermaid measures them. */
export const DIAGRAM_SANDBOX_ELEMENT_ID = 'ahve-diagram-sandbox';

// How long edits must pause before the sources are drawn again. Drawing on every keystroke would make typing in a
// source lag behind.
const RESCAN_DELAY_MS = 300;

// How many drawn results are kept beyond those the tree needs. Undo, redo and saving replace the whole tree, and the
// kept results let the diagrams come back at once instead of being drawn again.
const RESULT_LIMIT = 64;

/**
 * Ports of the diagram view. None of them hold a value; each is read on every call, because document replacement
 * swaps what is behind them.
 */
export interface DiagramViewPorts {
  /** Returns the editor root. */
  readEditorRoot(): HTMLElement | undefined;

  /** Loads the diagram renderer. Called at most once. */
  loadRenderer(): Promise<DiagramRenderer>;

  /**
   * Replaces the generated rules that draw the diagram images.
   *
   * @param rules The complete text of the rules.
   */
  applyRules(rules: string): void;

  /** Records one diagnostic line for maintainers. */
  reportDiagnostic(detail: string): void;
}

/**
 * Returns the diagrams a range selection wholly contains. Changes nothing.
 *
 * A collapsed selection contains none. The caret never enters a diagram, so a range that contains one reaches past
 * both of its ends.
 *
 * @param root The editor root.
 * @param range The selection range, or `undefined` when there is none inside the editor root.
 * @returns The diagram source blocks, in tree order.
 */
export function readSelectedDiagrams(root: Element, range: Range | undefined): Element[] {
  if (range === undefined || range.collapsed) {
    return [];
  }
  return findDiagramSources(root).filter((block) => {
    const whole = root.ownerDocument.createRange();
    whole.selectNode(block);
    return range.compareBoundaryPoints(Range.START_TO_START, whole) <= 0
      && range.compareBoundaryPoints(Range.END_TO_END, whole) >= 0;
  });
}

/**
 * Creates the sink that holds the generated rules in a stylesheet built by the view.
 *
 * The images are drawn by pseudo-elements, so the rules name each diagram by its mark. A built stylesheet adds
 * nothing to the tree, unlike a `style` element, which the content security policy would refuse anyway.
 *
 * @param document The document of the view.
 * @returns The sink. The stylesheet is created and adopted on the first call.
 */
export function createDiagramRuleSink(document: Document): (rules: string) => void {
  let sheet: CSSStyleSheet | undefined;
  return (rules) => {
    if (sheet === undefined) {
      sheet = new CSSStyleSheet();
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    }
    sheet.replaceSync(rules);
  };
}

/**
 * Shows every diagram source block as its diagram: the drawn image, or a card when the source is empty or cannot be
 * drawn.
 *
 * The tree only receives marks in the internal namespace, which never reach the saved or copied HTML. The images
 * themselves live in generated rules outside the tree. Created once per view and not recreated on remount.
 */
export class DiagramView {
  private readonly results = new Map<string, DiagramResult>();

  private readonly tokens = new Map<string, number>();

  private readonly images = new Map<number, DiagramImage>();

  private readonly inFlight = new Set<string>();

  // Zoom levels by source rather than by block: undo, redo and saving replace the whole tree, and a diagram keeps its
  // zoom level across them. Levels at 100% are not held.
  private readonly zooms = new Map<string, number>();

  private nextToken = 1;

  private nextRenderId = 1;

  private theme: DiagramTheme;

  private renderer: Promise<DiagramRenderer | undefined> | undefined;

  private queue: Promise<void> = Promise.resolve();

  private appliedRules = '';

  private pendingScan: ReturnType<typeof setTimeout> | undefined;

  private pendingSelection: number | undefined;

  private subscribed = false;

  private sandbox: HTMLElement | undefined;

  // The edit notification is carried by the edit itself, so nothing may escape from here.
  private readonly onEdit = (): void => {
    this.runGuarded(() => {
      if (this.pendingScan !== undefined) {
        clearTimeout(this.pendingScan);
      }
      // The same timer the body output debounces with. The wait belongs to the editing, not to the view window.
      this.pendingScan = setTimeout(() => {
        this.pendingScan = undefined;
        this.runGuarded(() => this.scan());
      }, RESCAN_DELAY_MS);
      this.onSelectionChange();
    });
  };

  private readonly onSelectionChange = (): void => {
    if (this.pendingSelection !== undefined) {
      return;
    }
    // Coalesced into one evaluation per frame. A drag selection fires the event many times per frame.
    this.pendingSelection = this.view.requestAnimationFrame(() => {
      this.pendingSelection = undefined;
      this.runGuarded(() => this.followSelection());
    });
  };

  /**
   * @param view The view window.
   * @param localizer The localizer. Supplies the notices of the cards.
   * @param labelTarget Where the notices are handed to. An element outside the editor root.
   * @param ports Ports of the diagram view.
   */
  constructor(
    private readonly view: Window,
    localizer: Localizer,
    labelTarget: HTMLElement,
    private readonly ports: DiagramViewPorts,
  ) {
    this.theme = readDiagramTheme(view.document.body);
    try {
      // The stylesheet spells no message. The values are quoted with JSON notation, which a CSS string reads alike.
      labelTarget.style.setProperty(
        DIAGRAM_ERROR_LABEL_PROPERTY,
        JSON.stringify(localizer.getMessage('diagram.renderError')),
      );
      labelTarget.style.setProperty(
        DIAGRAM_EMPTY_LABEL_PROPERTY,
        JSON.stringify(localizer.getMessage('diagram.empty')),
      );
    } catch (error) {
      ports.reportDiagnostic(`Could not hand the diagram notices to the display: ${String(error)}`);
    }
  }

  /**
   * Shows the diagrams of a newly mounted tree and subscribes to its edits.
   *
   * @param session That mount's editing session. Only its registration port is taken.
   */
  handleMountCompleted(session: Pick<EditingSession, 'addEditListener'>): void {
    session.addEditListener(this.onEdit);
    if (!this.subscribed) {
      this.subscribed = true;
      this.view.document.addEventListener('selectionchange', this.onSelectionChange);
      // VS Code changes the classes of the body when the color theme changes.
      new MutationObserver(() => this.runGuarded(() => this.handleThemeChange()))
        .observe(this.view.document.body, { attributes: true, attributeFilter: ['class'] });
    }
    this.runGuarded(() => {
      this.scan();
      this.followSelection();
    });
  }

  /**
   * Returns the zoom level of a diagram.
   *
   * @param block The diagram source block.
   * @returns The factor of its usual size. 1 for a diagram never zoomed.
   */
  readZoom(block: Element): number {
    return this.zooms.get(readDiagramSource(block)) ?? 1;
  }

  /**
   * Shows a diagram, and every diagram with the same source, at a zoom level. Only the generated rules and the marks
   * change, so neither the saved HTML nor the edit history sees it.
   *
   * @param block The diagram source block.
   * @param level The factor of its usual size.
   * @returns Whether the zoom level changed.
   */
  zoomDiagram(block: Element, level: number): boolean {
    const source = readDiagramSource(block);
    if ((this.zooms.get(source) ?? 1) === level) {
      return false;
    }
    if (level === 1) {
      this.zooms.delete(source);
    } else {
      this.zooms.set(source, level);
    }
    const root = this.ports.readEditorRoot();
    if (root !== undefined) {
      this.runGuarded(() => this.updateRules(root));
    }
    return true;
  }

  /**
   * Puts the kept results on every diagram source block and draws the sources that have none yet.
   *
   * A block whose source has no result yet keeps the marks it has, so an edited diagram keeps showing the previous
   * drawing until the new one is ready.
   */
  private scan(): void {
    const root = this.ports.readEditorRoot();
    if (root === undefined) {
      return;
    }
    const missing = new Map<string, string>();
    for (const block of findDiagramSources(root)) {
      toggleMark(block, DIAGRAM_BLOCK_MARK_NAME, true);
      const source = readDiagramSource(block);
      const empty = source.trim() === '';
      toggleMark(block, DIAGRAM_EMPTY_MARK_NAME, empty);
      if (empty) {
        block.removeAttributeNS(DIAGRAM_MARK_NAMESPACE, DIAGRAM_MARK_NAME);
        block.removeAttributeNS(DIAGRAM_MARK_NAMESPACE, DIAGRAM_ERROR_MARK_NAME);
        continue;
      }
      const key = this.toKey(source);
      const result = this.results.get(key);
      if (result === undefined) {
        missing.set(key, source);
      } else {
        this.applyResult(block, key, result);
      }
    }
    this.updateRules(root);
    if (missing.size > 0) {
      this.draw(missing);
    }
  }

  /**
   * Draws the sources one at a time, then puts the results on the current tree.
   *
   * @param missing The sources keyed by theme and source.
   */
  private draw(missing: ReadonlyMap<string, string>): void {
    const theme = this.theme;
    const pending = [...missing].filter(([key]) => !this.inFlight.has(key));
    if (pending.length === 0) {
      return;
    }
    for (const [key] of pending) {
      this.inFlight.add(key);
    }
    this.queue = this.queue.then(async () => {
      try {
        const renderer = await this.readRenderer();
        for (const [key, source] of pending) {
          if (renderer === undefined) {
            // Without a renderer nothing can be drawn, so every diagram shows the error card.
            this.storeResult(key, DIAGRAM_FAILURE);
            continue;
          }
          const id = `ahve-diagram-${this.nextRenderId}`;
          this.nextRenderId += 1;
          this.storeResult(key, await renderDiagram(renderer, source, theme, id, this.readSandbox()));
          this.inFlight.delete(key);
        }
        this.scan();
      } catch (error) {
        // A rejected step would stop every later drawing, so the failure is recorded and the queue goes on.
        this.ports.reportDiagnostic(`Could not draw the diagrams: ${String(error)}`);
      } finally {
        for (const [key] of pending) {
          this.inFlight.delete(key);
        }
      }
    });
  }

  /**
   * Returns the renderer, loading it on the first call.
   *
   * @returns The renderer, or `undefined` when it could not be loaded.
   */
  private readRenderer(): Promise<DiagramRenderer | undefined> {
    if (this.renderer === undefined) {
      this.renderer = this.ports.loadRenderer().catch((error: unknown) => {
        this.ports.reportDiagnostic(`Could not load the diagram renderer: ${String(error)}`);
        return undefined;
      });
    }
    return this.renderer;
  }

  /**
   * Returns the element diagrams are laid out in while they are measured, creating it outside the editor root.
   *
   * @returns The sandbox.
   */
  private readSandbox(): HTMLElement {
    if (this.sandbox === undefined || !this.sandbox.isConnected) {
      const sandbox = this.view.document.createElement('div');
      sandbox.id = DIAGRAM_SANDBOX_ELEMENT_ID;
      sandbox.setAttribute('aria-hidden', 'true');
      this.view.document.body.append(sandbox);
      this.sandbox = sandbox;
    }
    return this.sandbox;
  }

  /**
   * Keeps a result, dropping the oldest ones past the limit unless the tree still needs them.
   *
   * The limit only bounds the results the tree no longer needs. Dropping a result the tree still needs would make
   * the next scan find its source missing and draw it again, over and over.
   *
   * @param key The theme and source.
   * @param result The result.
   */
  private storeResult(key: string, result: DiagramResult): void {
    this.results.set(key, result);
    if (result.kind === 'image') {
      const token = this.nextToken;
      this.nextToken += 1;
      this.tokens.set(key, token);
      this.images.set(token, result);
    }
    const needed = this.readNeededKeys();
    needed.add(key);
    for (const oldKey of this.results.keys()) {
      if (this.results.size <= RESULT_LIMIT) {
        break;
      }
      if (needed.has(oldKey)) {
        continue;
      }
      const token = this.tokens.get(oldKey);
      this.results.delete(oldKey);
      this.tokens.delete(oldKey);
      if (token !== undefined) {
        this.images.delete(token);
      }
    }
  }

  /**
   * Returns the keys of the results the tree needs: those of its sources, whether drawn or not, and those of the
   * images it shows. An edited block keeps showing the image of its previous source until the new one is drawn.
   *
   * @returns The keys.
   */
  private readNeededKeys(): Set<string> {
    const needed = new Set<string>();
    const root = this.ports.readEditorRoot();
    if (root === undefined) {
      return needed;
    }
    for (const block of findDiagramSources(root)) {
      const source = readDiagramSource(block);
      if (source.trim() !== '') {
        needed.add(this.toKey(source));
      }
    }
    const shown = this.readShownTokens(root);
    for (const [key, token] of this.tokens) {
      if (shown.has(token)) {
        needed.add(key);
      }
    }
    return needed;
  }

  /**
   * Puts the marks of a result on a block.
   *
   * @param block The diagram source block.
   * @param key The theme and source.
   * @param result The result.
   */
  private applyResult(block: Element, key: string, result: DiagramResult): void {
    const token = this.tokens.get(key);
    if (result.kind === 'image' && token !== undefined) {
      block.removeAttributeNS(DIAGRAM_MARK_NAMESPACE, DIAGRAM_ERROR_MARK_NAME);
      if (block.getAttributeNS(DIAGRAM_MARK_NAMESPACE, DIAGRAM_MARK_NAME) !== String(token)) {
        block.setAttributeNS(DIAGRAM_MARK_NAMESPACE, DIAGRAM_MARK_NAME, String(token));
      }
      return;
    }
    block.removeAttributeNS(DIAGRAM_MARK_NAMESPACE, DIAGRAM_MARK_NAME);
    if (!block.hasAttributeNS(DIAGRAM_MARK_NAMESPACE, DIAGRAM_ERROR_MARK_NAME)) {
      block.setAttributeNS(DIAGRAM_MARK_NAMESPACE, DIAGRAM_ERROR_MARK_NAME, '');
    }
  }

  /**
   * Replaces the generated rules with one rule per image shown in the tree, and moves the zoomed mark to the blocks
   * whose image is shown at another zoom level.
   *
   * @param root The editor root.
   */
  private updateRules(root: Element): void {
    const zoomsByToken = new Map<number, number>();
    for (const [key, token] of this.tokens) {
      // The key holds the theme before the first line break, and the source after it.
      zoomsByToken.set(token, this.zooms.get(key.slice(key.indexOf('\n') + 1)) ?? 1);
    }
    const rules: string[] = [];
    for (const token of this.readShownTokens(root)) {
      const image = this.images.get(token);
      if (image === undefined) {
        continue;
      }
      // The URL is percent-encoded, so it can hold no quote, backslash or line break that would end the string.
      rules.push(
        `#${EDITOR_ROOT_ELEMENT_ID} pre[*|${DIAGRAM_MARK_NAME}="${token}"]::after {`
        + ` background-image: url("${image.url}");`
        + ` ${readImageWidth(image, zoomsByToken.get(token) ?? 1)}`
        + ` aspect-ratio: ${image.width} / ${image.height}; }`,
      );
    }
    for (const block of findDiagramSources(root)) {
      const token = block.getAttributeNS(DIAGRAM_MARK_NAMESPACE, DIAGRAM_MARK_NAME);
      toggleMark(block, DIAGRAM_ZOOMED_MARK_NAME, token !== null && (zoomsByToken.get(Number(token)) ?? 1) !== 1);
    }
    const text = rules.join('\n');
    if (text !== this.appliedRules) {
      this.appliedRules = text;
      this.ports.applyRules(text);
    }
  }

  /**
   * Returns the tokens of the images the tree shows.
   *
   * @param root The editor root. Read from the ports when omitted.
   * @returns The tokens.
   */
  private readShownTokens(root: Element | undefined = this.ports.readEditorRoot()): Set<number> {
    const shown = new Set<number>();
    if (root === undefined) {
      return shown;
    }
    for (const block of findDiagramSources(root)) {
      const value = block.getAttributeNS(DIAGRAM_MARK_NAMESPACE, DIAGRAM_MARK_NAME);
      if (value !== null) {
        shown.add(Number(value));
      }
    }
    return shown;
  }

  /** Moves the marks of the selected diagrams to follow the selection. */
  private followSelection(): void {
    const root = this.ports.readEditorRoot();
    if (root === undefined) {
      return;
    }
    const selected = readSelectedDiagrams(root, readSelectionRange(root));
    for (const block of findDiagramSources(root)) {
      toggleMark(block, DIAGRAM_SELECTED_MARK_NAME, selected.includes(block));
    }
  }

  /** Draws every diagram again when the theme changes. */
  private handleThemeChange(): void {
    const theme = readDiagramTheme(this.view.document.body);
    if (theme === this.theme) {
      return;
    }
    this.theme = theme;
    this.scan();
  }

  /**
   * Returns the key of a source under the current theme.
   *
   * @param source The source.
   * @returns The key.
   */
  private toKey(source: string): string {
    return `${this.theme}\n${source}`;
  }

  /**
   * Runs display work without letting exceptions escape. Returning an exception to an edit notification or a
   * browser listener would stop the edit itself midway merely because drawing failed.
   *
   * @param action The work to run.
   */
  private runGuarded(action: () => void): void {
    try {
      action();
    } catch (error) {
      this.ports.reportDiagnostic(`Could not update the diagrams: ${String(error)}`);
    }
  }
}

/**
 * Returns the width declarations of an image at a zoom level.
 *
 * The usual size is the drawn width, shrunk to the column when wider. A zoom level scales that usual size, so the
 * first step from a shrunk diagram grows it from what is on screen, and the diagram may then outgrow the column.
 *
 * @param image The drawn image.
 * @param level The zoom level.
 * @returns The declarations.
 */
function readImageWidth(image: DiagramImage, level: number): string {
  if (level === 1) {
    return `width: ${image.width}px;`;
  }
  return `width: calc(min(${image.width}px, 100%) * ${level}); max-width: none;`;
}

/**
 * Puts or removes a mark, touching the attribute only when it changes.
 *
 * @param block The diagram source block.
 * @param name The mark.
 * @param present Whether the mark should be there.
 */
function toggleMark(block: Element, name: string, present: boolean): void {
  const has = block.hasAttributeNS(DIAGRAM_MARK_NAMESPACE, name);
  if (present && !has) {
    block.setAttributeNS(DIAGRAM_MARK_NAMESPACE, name, '');
  } else if (!present && has) {
    block.removeAttributeNS(DIAGRAM_MARK_NAMESPACE, name);
  }
}
