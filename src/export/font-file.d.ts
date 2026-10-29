// The bundle writes an imported font as a file next to itself, and the import is the path of that file relative to
// the bundle.
declare module '*.ttf' {
  const path: string;
  export default path;
}
