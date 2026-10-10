/** The Mermaid theme a diagram is drawn with. */
export type DiagramTheme = 'default' | 'dark';

/** The subset of the Mermaid configuration the view sets. */
export interface DiagramConfig {
  readonly startOnLoad: boolean;
  readonly theme?: DiagramTheme;
  readonly securityLevel?: 'strict';
  readonly htmlLabels?: boolean;
  readonly maxTextSize?: number;
  readonly maxEdges?: number;
  readonly suppressErrorRendering?: boolean;
}

/** The part of Mermaid the view calls. */
export interface DiagramRenderer {
  /** Replaces the configuration used by the following renders. */
  initialize(config: DiagramConfig): void;

  /**
   * Renders a source into SVG markup.
   *
   * @param id The id of the SVG element, unique among renders in progress.
   * @param source The Mermaid source.
   * @param container The element the diagram is laid out in while it is measured.
   * @returns The SVG markup.
   */
  render(id: string, source: string, container: Element): Promise<string>;
}

/** A drawn diagram: a `data:` URL of the SVG and its intrinsic size in CSS pixels. */
export interface DiagramImage {
  readonly kind: 'image';
  readonly url: string;
  readonly width: number;
  readonly height: number;
}

/** A diagram that could not be drawn. */
export interface DiagramFailure {
  readonly kind: 'error';
}

/** The outcome of drawing one source. */
export type DiagramResult = DiagramImage | DiagramFailure;

// Limits past which a source is refused instead of drawn. They keep a huge source from stalling the view.
const MAX_TEXT_SIZE = 50000;
const MAX_EDGES = 500;

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/** The result of a source that could not be drawn. */
export const DIAGRAM_FAILURE: DiagramFailure = { kind: 'error' };

/**
 * Builds the configuration a diagram is drawn with.
 *
 * Strict security keeps click handlers inert and sanitizes labels, and labels are drawn as SVG text instead of HTML.
 * Mermaid's own error diagram is suppressed, because the view shows its own notice under the source.
 *
 * @param theme The theme to draw with.
 * @returns The configuration.
 */
export function createDiagramConfig(theme: DiagramTheme): DiagramConfig {
  return {
    startOnLoad: false,
    theme,
    securityLevel: 'strict',
    htmlLabels: false,
    maxTextSize: MAX_TEXT_SIZE,
    maxEdges: MAX_EDGES,
    suppressErrorRendering: true,
  };
}

/**
 * Decides the theme from the classes VS Code puts on the body of the view.
 *
 * @param body The body element of the view.
 * @returns `dark` for a dark or dark high contrast theme, otherwise `default`.
 */
export function readDiagramTheme(body: Element): DiagramTheme {
  const classes = body.classList;
  if (classes.contains('vscode-dark')) {
    return 'dark';
  }
  return classes.contains('vscode-high-contrast') && !classes.contains('vscode-high-contrast-light')
    ? 'dark'
    : 'default';
}

/**
 * Turns SVG markup into an image with an intrinsic size.
 *
 * Mermaid sizes the SVG to its container (`width="100%"` with a maximum width), which an image does not have. The
 * size is fixed to the view box instead, so the image keeps its proportions wherever it is drawn.
 *
 * @param svg The SVG markup.
 * @returns The image, or `undefined` when the markup is not an SVG with a usable size.
 */
export function toDiagramImage(svg: string): DiagramImage | undefined {
  const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const root = parsed.documentElement;
  if (root.localName !== 'svg' || root.namespaceURI !== SVG_NAMESPACE) {
    return undefined;
  }

  const size = readSvgSize(root);
  if (size === undefined) {
    return undefined;
  }
  root.setAttribute('width', String(size.width));
  root.setAttribute('height', String(size.height));
  removeMaxWidth(root);

  const markup = new XMLSerializer().serializeToString(root);
  return {
    kind: 'image',
    url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`,
    width: size.width,
    height: size.height,
  };
}

/**
 * Draws one source.
 *
 * Every failure, whether a syntax error, a source over the limits or an unexpected exception, becomes a failure
 * result. The source is the author's content, so a failure is shown to the reader rather than recorded.
 *
 * @param renderer The diagram renderer.
 * @param source The Mermaid source.
 * @param theme The theme to draw with.
 * @param id The id of the SVG element, unique among renders in progress.
 * @param container The element the diagram is laid out in while it is measured. Emptied afterwards.
 * @returns The result.
 */
export async function renderDiagram(
  renderer: DiagramRenderer,
  source: string,
  theme: DiagramTheme,
  id: string,
  container: Element,
): Promise<DiagramResult> {
  try {
    renderer.initialize(createDiagramConfig(theme));
    return toDiagramImage(await renderer.render(id, source, container)) ?? DIAGRAM_FAILURE;
  } catch {
    return DIAGRAM_FAILURE;
  } finally {
    // A failed render can leave its partial output behind, which would be measured with the next diagram.
    container.replaceChildren();
  }
}

/**
 * Reads the size of an SVG from its view box, or from its width and height when it has none.
 *
 * @param root The SVG root element.
 * @returns The positive, finite size, or `undefined`.
 */
function readSvgSize(root: Element): { width: number; height: number } | undefined {
  const viewBox = root.getAttribute('viewBox')?.trim().split(/[\s,]+/u);
  const width = viewBox?.length === 4 ? Number(viewBox[2]) : Number.parseFloat(root.getAttribute('width') ?? '');
  const height = viewBox?.length === 4 ? Number(viewBox[3]) : Number.parseFloat(root.getAttribute('height') ?? '');
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return undefined;
  }
  return { width, height };
}

/**
 * Removes the maximum width declaration from the `style` of the SVG root, keeping any other declaration.
 *
 * @param root The SVG root element.
 */
function removeMaxWidth(root: Element): void {
  const style = root.getAttribute('style');
  if (style === null) {
    return;
  }
  const kept = style
    .split(';')
    .map((declaration) => declaration.trim())
    .filter((declaration) => declaration !== '' && !/^max-width\s*:/iu.test(declaration));
  if (kept.length === 0) {
    root.removeAttribute('style');
    return;
  }
  root.setAttribute('style', `${kept.join('; ')};`);
}
