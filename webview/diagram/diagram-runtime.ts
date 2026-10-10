// Referenced here so that every project that compiles this file also sees the declaration of the entry.
/// <reference path="./mermaid-module.d.ts" />
import type { DiagramConfig, DiagramRenderer } from './diagram-render';

/**
 * Loads Mermaid and returns it as a diagram renderer.
 *
 * Mermaid is bundled into the view, but it is imported dynamically so that the library is evaluated only when a
 * document first shows a diagram source block. Opening a document without diagrams pays only for parsing the bundle.
 * The prebuilt minified entry keeps the bundle small even in development builds.
 *
 * @returns The diagram renderer.
 * @throws When the loaded module does not have the functions the view uses.
 */
export async function loadDiagramRenderer(): Promise<DiagramRenderer> {
  const loaded = await import('mermaid/dist/mermaid.esm.min.mjs');
  const api: unknown = loaded.default;
  if (typeof api !== 'object' || api === null) {
    throw new Error('The Mermaid module has no default export');
  }
  const initialize: unknown = Reflect.get(api, 'initialize');
  const render: unknown = Reflect.get(api, 'render');
  if (typeof initialize !== 'function' || typeof render !== 'function') {
    throw new Error('The Mermaid module lacks initialize or render');
  }

  const renderer: DiagramRenderer = {
    initialize: (config: DiagramConfig) => {
      Reflect.apply(initialize, api, [config]);
    },
    render: async (id: string, source: string, container: Element) => {
      const result: unknown = await Reflect.apply(render, api, [id, source, container]);
      const svg: unknown = typeof result === 'object' && result !== null ? Reflect.get(result, 'svg') : undefined;
      if (typeof svg !== 'string') {
        throw new Error('Mermaid returned no SVG');
      }
      return svg;
    },
  };
  // Keep Mermaid from looking for `.mermaid` elements on its own. It would render them into the editor root and
  // rewrite the document.
  renderer.initialize({ startOnLoad: false });
  return renderer;
}
