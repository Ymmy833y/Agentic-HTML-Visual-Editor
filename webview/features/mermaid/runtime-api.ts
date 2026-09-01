export type MermaidTheme = 'default' | 'dark';

export interface MermaidRuntime {
  initialize(theme: MermaidTheme): void;
  render(id: string, source: string): Promise<string>;
}

export const MERMAID_RUNTIME_GLOBAL = '__ahveMermaidRuntime';
export const MERMAID_RUNTIME_READY_EVENT = 'ahve-mermaid-runtime-ready';

declare global {
  interface Window {
    __ahveMermaidRuntime?: MermaidRuntime;
  }
}
