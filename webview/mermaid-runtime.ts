// This is a separate, lazily loaded Webview entry point. Keep the public shape
// deliberately small so the main editor bundle never imports Mermaid itself.

import mermaid from 'mermaid';
import {
  MERMAID_RUNTIME_GLOBAL,
  MERMAID_RUNTIME_READY_EVENT,
  type MermaidRuntime,
  type MermaidTheme,
} from './features/mermaid/runtime-api';

const SECURE_CONFIG_KEYS = [
  'secure',
  'securityLevel',
  'startOnLoad',
  'maxTextSize',
  'suppressErrorRendering',
  'maxEdges',
  'htmlLabels',
  'dompurifyConfig',
];

const runtime: MermaidRuntime = {
  initialize(theme: MermaidTheme): void {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      htmlLabels: false,
      suppressErrorRendering: true,
      maxTextSize: 50000,
      maxEdges: 500,
      secure: SECURE_CONFIG_KEYS,
      theme,
    });
  },

  async render(id: string, source: string): Promise<string> {
    const result = await mermaid.render(id, source);
    return result.svg;
  },
};

window[MERMAID_RUNTIME_GLOBAL] = runtime;
window.dispatchEvent(new Event(MERMAID_RUNTIME_READY_EVENT));
