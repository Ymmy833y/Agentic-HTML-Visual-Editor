const esbuild = require('esbuild');
const path = require('path');

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

const baseOptions = {
  bundle: true,
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

const extensionConfig = {
  ...baseOptions,
  entryPoints: [path.join(__dirname, 'src/extension.ts')],
  outfile: path.join(__dirname, 'dist/extension.js'),
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  external: ['vscode'],
};

// CSS files are imported from webview/main.ts and emitted as dist/webview.css
// alongside the JS bundle.
const webviewConfig = {
  ...baseOptions,
  entryPoints: [path.join(__dirname, 'webview/main.ts')],
  outfile: path.join(__dirname, 'dist/webview.js'),
  platform: 'browser',
  target: 'es2022',
  format: 'iife',
  loader: { '.css': 'css' },
};

async function run() {
  if (watch) {
    const extCtx = await esbuild.context(extensionConfig);
    const webCtx = await esbuild.context(webviewConfig);
    await Promise.all([extCtx.watch(), webCtx.watch()]);
    console.log('Watching for changes...');
  } else {
    await Promise.all([
      esbuild.build(extensionConfig),
      esbuild.build(webviewConfig),
    ]);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
