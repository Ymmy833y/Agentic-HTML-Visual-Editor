import { describe, expect, it } from 'vitest';

import { readDiagramTheme, renderDiagram, toDiagramImage } from '../../webview/diagram/diagram-render';
import type { DiagramConfig, DiagramRenderer } from '../../webview/diagram/diagram-render';

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="100%" style="max-width: 120px; background: red;"'
  + ' viewBox="0 0 120 80"><rect width="10" height="10"/></svg>';

/**
 * Decodes the SVG markup held by a `data:` URL.
 *
 * @param url The URL.
 * @returns The markup.
 */
function decode(url: string): string {
  return decodeURIComponent(url.slice(url.indexOf(',') + 1));
}

/**
 * Creates a renderer that records the configurations it receives and answers with a fixed result.
 *
 * @param answer What a render returns or throws.
 * @returns The renderer and the recorded configurations.
 */
function createRenderer(answer: () => string): { renderer: DiagramRenderer; configs: DiagramConfig[] } {
  const configs: DiagramConfig[] = [];
  const renderer: DiagramRenderer = {
    initialize: (config) => {
      configs.push(config);
    },
    render: () => Promise.resolve().then(answer),
  };
  return { renderer, configs };
}

describe('turning SVG into an image', () => {
  it('sizes an SVG with a view box to the view box and drops the maximum width, keeping other declarations', () => {
    const image = toDiagramImage(SVG);
    const markup = new DOMParser().parseFromString(decode(image?.url ?? ''), 'image/svg+xml').documentElement;

    expect([
      image?.url.startsWith('data:image/svg+xml;charset=utf-8,'),
      image?.width,
      image?.height,
      markup.getAttribute('width'),
      markup.getAttribute('height'),
      markup.getAttribute('style'),
    ]).toEqual([true, 120, 80, '120', '80', 'background: red;']);
  });

  it('makes no image from a string that is not SVG', () => {
    expect([toDiagramImage('not svg'), toDiagramImage('<div xmlns="http://www.w3.org/1999/xhtml"></div>')])
      .toEqual([undefined, undefined]);
  });
});

describe('drawing a source', () => {
  it('returns an image result when the renderer returns SVG, and an error result when it throws', async () => {
    const container = document.createElement('div');
    const drawn = await renderDiagram(createRenderer(() => SVG).renderer, 'flowchart TD', 'default', 'd1', container);
    const failed = await renderDiagram(createRenderer(() => {
      throw new Error('Parse error');
    }).renderer, 'flowchart TD', 'default', 'd2', container);

    expect([drawn.kind, failed.kind]).toEqual(['image', 'error']);
  });

  it('draws with strict security, no HTML labels, the size limits, no error diagram and the given theme', async () => {
    const { renderer, configs } = createRenderer(() => SVG);

    await renderDiagram(renderer, 'flowchart TD', 'dark', 'd1', document.createElement('div'));

    expect(configs).toEqual([{
      startOnLoad: false,
      theme: 'dark',
      securityLevel: 'strict',
      htmlLabels: false,
      maxTextSize: 50000,
      maxEdges: 500,
      suppressErrorRendering: true,
    }]);
  });
});

describe('deciding the theme', () => {
  it('draws dark under dark and dark high contrast themes, and default otherwise', () => {
    const themes = [
      ['vscode-dark'],
      ['vscode-high-contrast'],
      ['vscode-light'],
      ['vscode-high-contrast', 'vscode-high-contrast-light'],
      [],
    ].map((classes) => {
      const body = document.createElement('body');
      body.classList.add(...classes);
      return readDiagramTheme(body);
    });

    expect(themes).toEqual(['dark', 'dark', 'default', 'default', 'default']);
  });
});
