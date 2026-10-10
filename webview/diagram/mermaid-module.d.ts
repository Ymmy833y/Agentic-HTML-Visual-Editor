// The prebuilt, minified ESM entry of Mermaid. Its shape is checked at run time, so it is declared as an unknown value
// rather than pulling in the library's type definitions.
declare module 'mermaid/dist/mermaid.esm.min.mjs' {
  const mermaid: unknown;
  export default mermaid;
}
