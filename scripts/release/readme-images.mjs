// Makes the images in the README: draws the header and footer banners, opens a sample document in VS Code and takes
// screenshots of it.
//
//   npm run readme:images   builds first, then runs this script to remake the images in assets/readme/
//
// Retake the screenshots whenever the look of the view changes. They show the development build (dist/), in a VS Code
// whose settings and extensions are kept apart in a temporary directory. On Linux without a display the script starts
// Xvfb itself. The window is 3200×2000 pixels at twice the scale, so on a machine with a display, use a larger screen.

import { spawn } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPOSITORY_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SAMPLE_DIR = fileURLToPath(new URL('./readme-images/', import.meta.url));
const OUTPUT_DIR = join(REPOSITORY_ROOT, 'assets', 'readme');

// The integration test configuration, which pins the VS Code version fetched when none is installed.
const INTEGRATION_TEST_CONFIG_URL = new URL('../../.vscode-test.mjs', import.meta.url);
const LINUX_VSCODE_EXECUTABLE = '/usr/share/code/code';

// The window size in CSS pixels, and its scale. The width keeps the toolbar on one row with the explorer and the
// sidebar open, and twice the scale keeps the text sharp when the README shows the image smaller.
const WINDOW_SIZE = { width: 1600, height: 1000 };
const SCALE = 2;
// The Xvfb screen is large enough for the window at twice the scale.
const XVFB_SCREEN = '3400x2200x24';

// The banner wording and colors, the same as the header of the prototype's README.
const BANNER_TITLE = 'Agentic HTML Visual Editor';
const BANNER_TAGLINE = 'A WYSIWYG bridge between AI agents and humans';
const AMBER = '#F59E0B';
const ORANGE = '#F97316';
const BANNER_WIDTH = 1280;
const HEADER_HEIGHT = 220;
const FOOTER_HEIGHT = 120;

// The document opened for the screenshots, and the marks written in it.
const SAMPLE_FILE = 'design-notes.html';
const SAMPLE_HEADING = 'Checkout Redesign';
const SAMPLE_COMMENT_ID = 'c-k3n8x2qa';

// The default margin, in CSS pixels, left around a cropped image.
const CROP_MARGIN = 24;

// The document toolbar, spelled as TOOLBAR_ELEMENT_ID in the view's toolbar.ts.
const TOOLBAR_SELECTOR = '#editor-toolbar';
// The space, in CSS pixels, left between the bottom of the toolbar and a heading scrolled up to it. Beyond the crop
// margin, it keeps out the shadow the toolbar casts once the document scrolls.
const HEADING_GAP = 32;
// The notifications VS Code shows at the bottom right of the window.
const NOTIFICATION_SELECTOR = '.notification-toast';

/**
 * @typedef {{ x: number, y: number, width: number, height: number }} Box A rectangle in CSS pixels of the window.
 * @typedef {{ page: import('@playwright/test').Page, editor: import('@playwright/test').Frame }} Screen
 *   The VS Code window, and the frame that holds the WYSIWYG document.
 * @typedef {{ electron: import('@playwright/test').Electron, executable: string, workDir: string, env: Record<string, string> }} LaunchOptions
 *   Playwright's Electron, the VS Code executable, the working directory, and environment variables to add.
 */

/**
 * Escapes text for HTML content and attribute values.
 *
 * @param {string} text The text.
 * @returns {string} The escaped text.
 */
function escapeHtml(text) {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

/**
 * Makes the HTML of one banner: a band whose bottom edge (header) or top edge (footer) is a wave. Only the header
 * carries wording.
 *
 * @param {{ kind: 'header' | 'footer', title?: string, tagline?: string }} options The kind of banner and its wording.
 * @returns {string} HTML for Chromium to open and capture, on a transparent background.
 */
export function renderBannerHtml({ kind, title = '', tagline = '' }) {
  const width = BANNER_WIDTH;
  const isHeader = kind === 'header';
  const height = isHeader ? HEADER_HEIGHT : FOOTER_HEIGHT;
  // A faint wave behind the front one gives the band some depth.
  const waves = isHeader
    ? [
        `M0 0H${width}V172C1090 214 930 128 720 160S330 214 0 150Z`,
        `M0 0H${width}V150C1060 196 900 112 690 146S300 196 0 132Z`,
      ]
    : [
        `M0 42C210 4 380 76 610 40S1040 6 ${width} 48V${height}H0Z`,
        `M0 64C230 26 420 96 650 60S1060 30 ${width} 70V${height}H0Z`,
      ];
  // The footer runs the gradient the other way, so that the two banners pair up.
  const [from, to] = isHeader ? [AMBER, ORANGE] : [ORANGE, AMBER];
  const text = isHeader
    ? [
        `<text x="50%" y="84" text-anchor="middle" font-size="44" font-weight="700" fill="#ffffff">${escapeHtml(title)}</text>`,
        `<text x="50%" y="124" text-anchor="middle" font-size="19" fill="#ffffff" fill-opacity="0.92">${escapeHtml(tagline)}</text>`,
      ].join('')
    : '';
  return [
    '<!DOCTYPE html><html><head><meta charset="utf-8">',
    '<style>html,body{margin:0;background:transparent}',
    'text{font-family:"Segoe UI","Helvetica Neue",Arial,"Liberation Sans","DejaVu Sans",sans-serif}</style>',
    '</head><body>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<defs><linearGradient id="fill" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${from}"/>`,
    `<stop offset="1" stop-color="${to}"/></linearGradient></defs>`,
    `<path d="${waves[0]}" fill="url(#fill)" fill-opacity="0.4"/>`,
    `<path d="${waves[1]}" fill="url(#fill)"/>`,
    text,
    '</svg></body></html>',
  ].join('');
}

/**
 * Reads the VS Code version that the integration tests pin, so that the screenshots and the tests use the same build.
 *
 * @returns {Promise<string>} The version.
 */
export async function readIntegrationTestVsCodeVersion() {
  const { default: config } = await import(INTEGRATION_TEST_CONFIG_URL.href);
  if (typeof config?.version !== 'string') {
    throw new Error('.vscode-test.mjs pins no VS Code version.');
  }
  return config.version;
}

/**
 * Starts Xvfb on Linux without a display, and returns the environment variables to give VS Code.
 *
 * @returns {Promise<{ env: Record<string, string>, stop: () => void }>} The environment variables to add, and a
 *   function that stops Xvfb.
 */
async function ensureDisplay() {
  if (process.platform !== 'linux' || process.env.DISPLAY) {
    return { env: {}, stop: () => {} };
  }
  // -displayfd lets Xvfb pick a free display number and write it to the fourth stream.
  const xvfb = spawn('Xvfb', ['-displayfd', '3', '-screen', '0', XVFB_SCREEN, '-nolisten', 'tcp'], {
    stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
  });
  const display = await new Promise((resolve, reject) => {
    let received = '';
    xvfb.stdio[3].on('data', (chunk) => {
      received += chunk;
      if (received.includes('\n')) {
        resolve(received.trim());
      }
    });
    xvfb.on('error', (error) => reject(new Error(`There is no display, and Xvfb could not start: ${error.message}`)));
    xvfb.on('exit', (code) => reject(new Error(`Xvfb exited (exit code ${code}).`)));
  });
  return { env: { DISPLAY: `:${display}` }, stop: () => xvfb.kill() };
}

/**
 * Finds the VS Code executable for the screenshots, looking in the same places as the integration tests and fetching
 * the same version when none is installed.
 *
 * @returns {Promise<string>} The path of the executable.
 */
async function findVsCode() {
  const installed = [process.env.AHVE_VSCODE_EXECUTABLE, LINUX_VSCODE_EXECUTABLE].find(
    (candidate) => candidate && existsSync(candidate),
  );
  if (installed) {
    return installed;
  }
  const { downloadAndUnzipVSCode } = await import('@vscode/test-electron');
  return downloadAndUnzipVSCode(await readIntegrationTestVsCodeVersion());
}

/**
 * The VS Code user settings for the screenshots. They hide the UI that has nothing to do with the extension and open
 * HTML in the WYSIWYG editor from the start.
 *
 * @param {'light' | 'dark'} theme The color theme.
 * @returns {Record<string, unknown>} The contents of settings.json.
 */
function vsCodeSettings(theme) {
  return {
    'workbench.colorTheme': theme === 'dark' ? 'Default Dark Modern' : 'Default Light Modern',
    'workbench.editorAssociations': { '*.html': 'ahve.editor' },
    'workbench.startupEditor': 'none',
    'workbench.tips.enabled': false,
    'workbench.secondarySideBar.defaultVisibility': 'hidden',
    // The operating system draws the title bar, so it stays out of the captured window content.
    'window.titleBarStyle': 'native',
    'window.customTitleBarVisibility': 'never',
    'window.commandCenter': false,
    'window.restoreWindows': 'none',
    'breadcrumbs.enabled': false,
    'chat.disableAIFeatures': true,
    'git.enabled': false,
    'git.openRepositoryInParentFolders': 'never',
    'extensions.ignoreRecommendations': true,
    'security.workspace.trust.enabled': false,
    'update.mode': 'none',
    'telemetry.telemetryLevel': 'off',
  };
}

/**
 * Starts VS Code with user data in the temporary directory and opens the sample document in the WYSIWYG editor.
 *
 * @param {LaunchOptions & { theme: 'light' | 'dark' }} options How to start VS Code, and the color theme.
 * @returns {Promise<Screen & { app: import('@playwright/test').ElectronApplication }>} The running VS Code, its window,
 *   and the frame that holds the WYSIWYG document.
 */
async function openSample({ electron, executable, workDir, theme, env }) {
  const userData = join(workDir, `user-${theme}`);
  mkdirSync(join(userData, 'User'), { recursive: true });
  writeFileSync(join(userData, 'User', 'settings.json'), JSON.stringify(vsCodeSettings(theme), null, 2));
  const workspace = join(workDir, 'project-notes');
  if (!existsSync(workspace)) {
    cpSync(SAMPLE_DIR, workspace, { recursive: true });
  }

  const app = await electron.launch({
    executablePath: executable,
    args: [
      // Lets VS Code start as root in a container and under Xvfb, and keeps it off the GPU where there is none.
      ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu'] : []),
      `--force-device-scale-factor=${SCALE}`,
      `--user-data-dir=${userData}`,
      `--extensions-dir=${join(workDir, 'extensions')}`,
      `--extensionDevelopmentPath=${REPOSITORY_ROOT}`,
      '--locale=en',
      '--skip-welcome',
      '--skip-release-notes',
      '--disable-workspace-trust',
      workspace,
      join(workspace, SAMPLE_FILE),
    ],
    env: { ...process.env, ...env },
    timeout: 60_000,
  });
  // Close VS Code even when something fails before the screenshots. Otherwise its window stays open, and on a machine
  // with a display the script does not end after giving the reason.
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }, size) => {
      const [window] = BrowserWindow.getAllWindows();
      window.setPosition(0, 0);
      window.setContentSize(size.width, size.height);
    }, WINDOW_SIZE);

    const editor = await waitForEditor(page);
    await clearNotifications(page);
    return { app, page, editor };
  } catch (error) {
    // Even if closing fails, the reason the screenshots could not be taken is what the user needs to see.
    await app.close().catch(() => {});
    throw error;
  }
}

/**
 * Waits for the frame that holds the WYSIWYG document. The webview is a nested frame, so it is found by the heading
 * of the sample.
 *
 * @param {import('@playwright/test').Page} page The VS Code window.
 * @returns {Promise<import('@playwright/test').Frame>} The frame that holds the document.
 */
async function waitForEditor(page) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      const found = await frame
        .locator('h1', { hasText: SAMPLE_HEADING })
        .count()
        .catch(() => 0);
      if (found > 0) {
        // Let the flicker right after loading settle before taking pictures.
        await page.waitForTimeout(1500);
        return frame;
      }
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`${SAMPLE_FILE} did not open in the WYSIWYG editor.`);
}

/**
 * Clears the notifications, so that ones unrelated to the extension, such as the warning about running as root, stay
 * out of the pictures. The root warning can appear after the document has opened, and would show up if it came after
 * the clearing, so the clearing waits for it.
 *
 * @param {import('@playwright/test').Page} page The VS Code window.
 */
async function clearNotifications(page) {
  if (process.getuid?.() === 0) {
    // If nothing appears, there is simply nothing to clear.
    await page
      .locator(NOTIFICATION_SELECTOR)
      .first()
      .waitFor({ state: 'visible', timeout: 30_000 })
      .catch(() => {});
  }
  await openCommandPalette(page);
  await page.keyboard.type('Notifications: Clear All Notifications');
  await page.waitForTimeout(500);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(800);
}

/**
 * Opens the command palette. F1 reaches VS Code even while the webview has the focus, but a press made while the focus
 * moves can be lost, so the palette is checked and F1 pressed again. Typing while the palette is closed would put the
 * text into the webview and scroll the document at every space.
 *
 * @param {import('@playwright/test').Page} page The VS Code window.
 */
async function openCommandPalette(page) {
  const palette = page.locator('.quick-input-widget');
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.keyboard.press('F1');
    const opened = await palette.waitFor({ state: 'visible', timeout: 2_000 }).then(
      () => true,
      () => false,
    );
    if (opened) {
      return;
    }
  }
  throw new Error('The command palette did not open, so the notifications cannot be cleared.');
}

/**
 * Takes the rectangle around several elements, adds a margin, and keeps it inside the window.
 *
 * @param {Array<Box | null>} boxes The rectangles of the elements.
 * @param {number} [margin] The margin around them. Make it narrower when a neighboring sentence or heading would show.
 * @returns {Box} The rectangle to crop.
 */
function unionClip(boxes, margin = CROP_MARGIN) {
  const present = boxes.filter((box) => box !== null);
  if (present.length === 0) {
    throw new Error('None of the elements to crop were found.');
  }
  const left = Math.max(0, Math.min(...present.map((box) => box.x)) - margin);
  const top = Math.max(0, Math.min(...present.map((box) => box.y)) - margin);
  const right = Math.min(WINDOW_SIZE.width, Math.max(...present.map((box) => box.x + box.width)) + margin);
  const bottom = Math.min(WINDOW_SIZE.height, Math.max(...present.map((box) => box.y + box.height)) + margin);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * Extends the crop down to the bottom of any single line it cuts through. Text cut through the middle looks like a
 * failed screenshot.
 *
 * @param {import('@playwright/test').Frame} editor The frame that holds the WYSIWYG document.
 * @param {Box} clip The rectangle to crop.
 * @returns {Promise<Box>} The rectangle with its bottom extended.
 */
async function includeCutLines(editor, clip) {
  const bottom = clip.y + clip.height;
  let extended = bottom;
  for (const line of await editor.locator('h1, h2, h3, p, li, summary, tr').all()) {
    const box = await line.boundingBox();
    // A tall block such as a table or a diagram is still recognizable when cut, so the crop does not grow for it.
    if (box !== null && box.height < 60 && box.y < bottom && box.y + box.height > bottom) {
      extended = Math.max(extended, box.y + box.height);
    }
  }
  return { ...clip, height: Math.min(WINDOW_SIZE.height, extended) - clip.y };
}

/**
 * Checks that the crop lies within the visible part of the document. A top above the bottom of the toolbar takes in
 * the toolbar or the VS Code tab strip, and a bottom below the webview takes in the VS Code status bar. Both happen when
 * the document scrolled to the wrong place, so the run stops with the reason before taking the picture.
 *
 * @param {string} name The file name of the image, given in the reason.
 * @param {Box} clip The rectangle to crop.
 * @param {{ top: number, bottom: number }} view The visible part of the document: the bottom of the toolbar and the
 *   bottom of the webview.
 */
export function assertClipInView(name, clip, view) {
  if (clip.y < view.top) {
    throw new Error(
      `Cannot take ${name}: the top of the crop (${clip.y}) is above the bottom of the toolbar (${view.top}), `
        + 'so the toolbar would show.',
    );
  }
  if (clip.y + clip.height > view.bottom) {
    throw new Error(
      `Cannot take ${name}: the bottom of the crop (${clip.y + clip.height}) is below the bottom of the webview `
        + `(${view.bottom}), so VS Code itself would show.`,
    );
  }
}

/**
 * Returns the top and the bottom of the visible part of the document, in window coordinates. The top is the bottom of
 * the toolbar, which stays at the top when the document scrolls, and the bottom is the bottom of the webview.
 *
 * @param {import('@playwright/test').Frame} editor The frame that holds the WYSIWYG document.
 * @returns {Promise<{ top: number, bottom: number }>} The visible part.
 */
async function readDocumentView(editor) {
  const toolbar = await editor.locator(TOOLBAR_SELECTOR).boundingBox();
  const frame = await (await editor.frameElement()).boundingBox();
  if (toolbar === null || frame === null) {
    throw new Error('Cannot read where the toolbar or the webview is.');
  }
  return { top: toolbar.y + toolbar.height, bottom: frame.y + frame.height };
}

/**
 * Scrolls the document so that the top of a heading sits HEADING_GAP below the toolbar. The toolbar stays at the top
 * while the document scrolls, so a heading aligned with the top of the view would hide under it. Near the end of the
 * document the scroll runs out and the heading stays lower.
 *
 * @param {import('@playwright/test').Locator} heading The heading.
 */
async function alignBelowToolbar(heading) {
  await heading.evaluate(
    (element, { selector, gap }) => {
      const toolbar = element.ownerDocument.querySelector(selector);
      if (toolbar === null) {
        throw new Error('The toolbar was not found.');
      }
      const offset = element.getBoundingClientRect().top - toolbar.getBoundingClientRect().bottom - gap;
      element.ownerDocument.defaultView?.scrollBy(0, offset);
    },
    { selector: TOOLBAR_SELECTOR, gap: HEADING_GAP },
  );
}

/**
 * Checks that no VS Code notification is showing. Notifications overlap the bottom right of the window, so one would
 * put UI unrelated to the extension in the picture.
 *
 * @param {import('@playwright/test').Page} page The VS Code window.
 * @param {string} name The file name of the image, given in the reason.
 */
async function assertNoNotifications(page, name) {
  const shown = await page.locator(NOTIFICATION_SELECTOR).filter({ visible: true }).allInnerTexts();
  if (shown.length > 0) {
    throw new Error(`Cannot take ${name}: VS Code notifications are showing and would appear (${shown.join(' / ')}).`);
  }
}

/**
 * Takes the whole window, after checking that no notification is showing.
 *
 * @param {import('@playwright/test').Page} page The VS Code window.
 * @param {string} outputDir The directory to write to.
 * @param {string} name The file name of the image.
 */
async function captureWindow(page, outputDir, name) {
  await assertNoNotifications(page, name);
  await page.screenshot({ path: join(outputDir, name) });
}

/**
 * Takes a crop, after checking that it lies within the visible part of the document and that no notification is
 * showing.
 *
 * @param {Screen} screen The VS Code window and the frame that holds the WYSIWYG document.
 * @param {string} outputDir The directory to write to.
 * @param {string} name The file name of the image.
 * @param {Box} clip The rectangle to crop.
 */
async function captureClip({ page, editor }, outputDir, name, clip) {
  assertClipInView(name, clip, await readDocumentView(editor));
  await assertNoNotifications(page, name);
  await page.screenshot({ path: join(outputDir, name), clip });
}

/**
 * Renders the two banners to PNG with Chromium.
 *
 * @param {import('@playwright/test').BrowserType} chromium Playwright's Chromium.
 * @param {string} outputDir The directory to write to.
 */
async function renderBanners(chromium, outputDir) {
  const browser = await chromium.launch();
  try {
    for (const [kind, file] of [
      ['header', 'banner.png'],
      ['footer', 'footer.png'],
    ]) {
      const page = await browser.newPage({
        viewport: { width: BANNER_WIDTH, height: kind === 'header' ? HEADER_HEIGHT : FOOTER_HEIGHT },
        deviceScaleFactor: SCALE,
      });
      await page.setContent(renderBannerHtml({ kind, title: BANNER_TITLE, tagline: BANNER_TAGLINE }));
      await page.screenshot({ path: join(outputDir, file), omitBackground: true });
      await page.close();
    }
  } finally {
    await browser.close();
  }
}

/**
 * Takes the overview: the sidebar open on the headings and comments, and the thread of a comment open.
 *
 * @param {Screen} screen The VS Code window and the frame that holds the WYSIWYG document.
 * @param {string} outputDir The directory to write to.
 */
async function captureOverview({ page, editor }, outputDir) {
  await editor.getByRole('button', { name: 'Sidebar', exact: true }).click();
  await editor.locator(`comment#${SAMPLE_COMMENT_ID}`).click();
  await editor.getByRole('dialog', { name: 'Comment Thread' }).waitFor({ state: 'visible' });
  await page.waitForTimeout(600);
  await captureWindow(page, outputDir, 'overview.png');
}

/**
 * Crops the annotated sentence together with its open thread, then closes the thread. Expects the thread that
 * {@link captureOverview} opened.
 *
 * @param {Screen} screen The VS Code window and the frame that holds the WYSIWYG document.
 * @param {string} outputDir The directory to write to.
 */
async function captureComments({ page, editor }, outputDir) {
  const paragraph = editor.locator('p', { has: editor.locator(`comment#${SAMPLE_COMMENT_ID}`) });
  const popup = editor.getByRole('dialog', { name: 'Comment Thread' });
  const clip = unionClip([await paragraph.boundingBox(), await popup.boundingBox()]);
  await captureClip({ page, editor }, outputDir, 'comments.png', await includeCutLines(editor, clip));
  await page.keyboard.press('Escape');
}

/**
 * Crops a table with its table actions menu open. The table is scrolled up below the toolbar first, so that the menu
 * opens downward: a menu pushed upward over the diagram would leave the picture unclear about what it shows.
 *
 * @param {Screen} screen The VS Code window and the frame that holds the WYSIWYG document.
 * @param {string} outputDir The directory to write to.
 */
async function captureTables({ page, editor }, outputDir) {
  const heading = editor.locator('h2', { hasText: 'Options Compared' });
  await alignBelowToolbar(heading);
  const table = editor.locator('table').first();
  await table.locator('td').nth(2).click({ button: 'right' });
  const menu = editor.getByRole('menu', { name: 'Table Actions' });
  await menu.waitFor({ state: 'visible' });
  await page.waitForTimeout(400);
  // A narrow margin keeps out the frame of the diagram above the heading.
  const clip = unionClip([await heading.boundingBox(), await table.boundingBox(), await menu.boundingBox()], 12);
  await captureClip({ page, editor }, outputDir, 'tables.png', await includeCutLines(editor, clip));
}

/**
 * Waits until a Mermaid diagram has been drawn. The diagram is the background image of the pre's ::after, and its
 * height changes once it is drawn, so its position is read only afterwards.
 *
 * @param {import('@playwright/test').Locator} diagram The pre that holds the diagram source.
 */
async function waitForDiagram(diagram) {
  await diagram.evaluate(
    (element) =>
      new Promise((resolve, reject) => {
        const started = Date.now();
        const poll = () => {
          if (getComputedStyle(element, '::after').backgroundImage.startsWith('url(')) {
            resolve(undefined);
          } else if (Date.now() - started > 30_000) {
            reject(new Error('The Mermaid diagram was not drawn.'));
          } else {
            setTimeout(poll, 200);
          }
        };
        poll();
      }),
  );
}

/**
 * Crops a Mermaid diagram with its heading. It is taken in the dark theme, to show that diagrams follow the VS Code
 * colors.
 *
 * @param {Screen} screen The VS Code window and the frame that holds the WYSIWYG document.
 * @param {string} outputDir The directory to write to.
 */
async function captureDiagrams({ page, editor }, outputDir) {
  const diagram = editor.locator('pre.mermaid').first();
  await waitForDiagram(diagram);
  // Scroll the heading up below the toolbar. At the position it opened in, the heading hides under the toolbar
  // whenever the document has scrolled.
  const heading = editor.locator('h2', { hasText: 'Flow' });
  await alignBelowToolbar(heading);
  await page.waitForTimeout(600);
  // A narrow margin keeps out the paragraph above the heading and the edge of the heading below the diagram.
  const clip = unionClip([await heading.boundingBox(), await diagram.boundingBox()], 8);
  await captureClip({ page, editor }, outputDir, 'diagrams.png', clip);
}

/**
 * Opens the sample in one theme, runs the captures in order, and closes VS Code whatever happens.
 *
 * @param {LaunchOptions} options How to start VS Code.
 * @param {'light' | 'dark'} theme The color theme.
 * @param {Array<(screen: Screen, outputDir: string) => Promise<void>>} captures The captures, run in this order.
 * @param {string} outputDir The directory to write to.
 */
async function captureScreens(options, theme, captures, outputDir) {
  const { app, page, editor } = await openSample({ ...options, theme });
  try {
    for (const capture of captures) {
      await capture({ page, editor }, outputDir);
    }
  } finally {
    await app.close();
  }
}

/**
 * Draws the banners, takes the screenshots, and copies them to assets/readme/ only when all of them are ready.
 *
 * @returns {Promise<number>} The exit code.
 */
async function main() {
  if (!existsSync(join(REPOSITORY_ROOT, 'dist', 'extension.js'))) {
    console.error('dist/ is missing. Run npm run readme:images, which builds first.');
    return 1;
  }
  const { chromium, _electron: electron } = await import('@playwright/test');
  // VS Code creates a socket under its user data, and the socket path is limited to 107 characters, so the temporary
  // directory has to keep the path short.
  const workDir = mkdtempSync(join(tmpdir(), 'ahve-readme-'));
  const staging = join(workDir, 'images');
  mkdirSync(staging);
  let display;
  try {
    display = await ensureDisplay();
    await renderBanners(chromium, staging);
    const options = { electron, executable: await findVsCode(), workDir, env: display.env };
    await captureScreens(options, 'light', [captureOverview, captureComments, captureTables], staging);
    await captureScreens(options, 'dark', [captureDiagrams], staging);

    // Replace the images only once all of them are ready, so that a failure halfway leaves no mix of old and new.
    mkdirSync(OUTPUT_DIR, { recursive: true });
    const files = readdirSync(staging).sort();
    for (const file of files) {
      copyFileSync(join(staging, file), join(OUTPUT_DIR, file));
    }
    console.log(`Wrote ${files.length} images to assets/readme/: ${files.join(', ')}`);
    return 0;
  } finally {
    display?.stop();
    rmSync(workDir, { recursive: true, force: true });
  }
}

// Runs only when executed directly, not when a test imports the module. Node.js keeps its own URL as the real path with
// symbolic links resolved, so the path it was started with is resolved too; otherwise a start through a link would end
// without taking any pictures.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    },
  );
}
