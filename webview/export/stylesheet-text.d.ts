// The stylesheets of the view, imported as their text. The bundler reads them with its text loader.
declare module '*.css' {
  const text: string;
  export default text;
}
