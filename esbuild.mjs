import * as esbuild from 'esbuild';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Build options for the extension host bundle.
// platform is set to browser so that a dependency on a Node.js built-in fails to resolve
// and breaks the build even for a desktop-targeted artifact (S-ACT-08). No polyfill is
// injected: injecting one would produce code that works on desktop but breaks only on the
// web version.
function createExtensionOptions(isDevelopment) {
  return {
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    bundle: true,
    platform: 'browser',
    target: 'es2022',
    format: 'cjs',
    // vscode is supplied by the runtime, so it is not pulled into the bundle.
    external: ['vscode'],
    sourcemap: isDevelopment,
    minify: !isDevelopment,
    logLevel: 'info',
  };
}

// Build options for the webview bundle.
// It is loaded as a <script> under CSP, so it is emitted as iife, which leaves no external
// dependency behind.
function createWebviewOptions(isDevelopment) {
  return {
    entryPoints: ['webview/main.ts'],
    outfile: 'dist/webview.js',
    bundle: true,
    platform: 'browser',
    target: 'es2022',
    format: 'iife',
    sourcemap: isDevelopment,
    minify: !isDevelopment,
    logLevel: 'info',
  };
}

// The e2e layer needs to call the view's body output entry point, but the production
// iife exposes no value to the outside. Building a separate entry point leaves the
// production bundle untouched, and the artifact it leaves behind during development
// is not part of the distributed package.
function createE2eProbeOptions() {
  return {
    entryPoints: ['tests/e2e/probe/serialization-probe.ts'],
    outfile: 'dist/webview-probe.js',
    bundle: true,
    platform: 'browser',
    target: 'es2022',
    format: 'iife',
    sourcemap: true,
    logLevel: 'info',
  };
}

// Build options for the webview stylesheet.
// The extension's own UI is styled here rather than with style attributes written where the elements
// are built, so that the look stays out of the code that decides what to show.
function createWebviewStyleOptions(isDevelopment) {
  return {
    entryPoints: ['webview/ui/webview.css'],
    outfile: 'dist/webview.css',
    bundle: true,
    sourcemap: isDevelopment,
    minify: !isDevelopment,
    logLevel: 'info',
  };
}

// ビルドする設定の一覧。第三者ライセンス表示の生成も本番の一覧を読み、配布物と同じ入力を数える。
export function createBuildOptionsList(isDevelopment) {
  return [
    createExtensionOptions(isDevelopment),
    createWebviewOptions(isDevelopment),
    createWebviewStyleOptions(isDevelopment),
    // Only development builds carry the E2E probe. npm run pretest:e2e runs the default build, so
    // the E2E layer always has it.
    ...(isDevelopment ? [createE2eProbeOptions()] : []),
  ];
}

async function main() {
  const isWatch = process.argv.includes('--watch');
  // A production build happens only when --production is passed. Unless the default is a
  // development build, debugging would launch on the output of the default build task
  // (npm run build), and breakpoints could not be set in the minified bundle. --production
  // is passed only by vscode:prepublish, so only the distributed package is a production build.
  const isDevelopment = !process.argv.includes('--production');
  const optionsList = createBuildOptionsList(isDevelopment);

  if (isWatch) {
    const contexts = await Promise.all(optionsList.map((options) => esbuild.context(options)));
    await Promise.all(contexts.map((context) => context.watch()));
    return;
  }

  await Promise.all(optionsList.map((options) => esbuild.build(options)));
}

// 設定の一覧を読み込むだけのスクリプトからはビルドを走らせず、直接実行されたときだけビルドする。Node.js は自身の URL を
// シンボリックリンクを解いた実体のパスで持つので、起動したパスも実体に直して比べる。直さないと、リンク越しの起動で
// ビルドせずに成功で終わる。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
