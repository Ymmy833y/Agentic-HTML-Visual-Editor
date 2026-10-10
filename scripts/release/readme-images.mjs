// README に載せる画像を作る。ヘッダーとフッターのバナーを描き、VS Code で見本の文書を開いて画面を撮る。
//
//   npm run readme:images   先にビルドしてから、このスクリプトで assets/readme/ の画像を作り直す
//
// 画面の見た目を変えたら撮り直す。撮るのは開発中のビルド（dist/）の画面で、手元の VS Code の設定や拡張は
// 一時ディレクトリに切り離して使わない。画面の無い Linux では Xvfb を自分で起動する。窓は 2 倍の倍率で
// 3200×2000 ピクセルになるので、画面のある環境ではそれより広い画面で撮る。

import { spawn } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPOSITORY_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SAMPLE_DIR = fileURLToPath(new URL('./readme-images/', import.meta.url));
const OUTPUT_DIR = join(REPOSITORY_ROOT, 'assets', 'readme');

// 手元に VS Code が無いときに取得する版。統合テストの .vscode-test.mjs と揃える。
const VSCODE_VERSION = '1.138.0';
const LINUX_VSCODE_EXECUTABLE = '/usr/share/code/code';

// 撮る窓の大きさ（CSS ピクセル）と倍率。エクスプローラーとサイドバーを開いてもツールバーが 1 段に収まる幅にし、
// README で縮めて表示しても文字が潰れないよう 2 倍で撮る。
const WINDOW_SIZE = { width: 1600, height: 1000 };
const SCALE = 2;
// Xvfb の画面は、2 倍にした窓が収まる大きさにする。
const XVFB_SCREEN = '3400x2200x24';

// バナーの文言と配色。プロトタイプの README のヘッダーと同じにする。
const BANNER_TITLE = 'Agentic HTML Visual Editor';
const BANNER_TAGLINE = 'A WYSIWYG bridge between AI agents and humans';
const AMBER = '#F59E0B';
const ORANGE = '#F97316';
const BANNER_WIDTH = 1280;
const HEADER_HEIGHT = 220;
const FOOTER_HEIGHT = 120;

// 撮影で開く文書と、そこに書いてある目印。
const SAMPLE_FILE = 'design-notes.html';
const SAMPLE_HEADING = 'Checkout Redesign';
const SAMPLE_COMMENT_ID = 'c-k3n8x2qa';

// 切り抜く画像の周りに残す余白の既定値（CSS ピクセル）。
const CROP_MARGIN = 24;

// 文書のツールバーの要素。webview の toolbar.ts の TOOLBAR_ELEMENT_ID と同じ綴りにする。
const TOOLBAR_SELECTOR = '#editor-toolbar';
// 見出しをツールバーの下へ送るときに、ツールバーの下端との間に空ける幅（CSS ピクセル）。切り抜きの余白に加え、
// 文書をスクロールすると浮き上がるツールバーの影が写らない分を取る。
const HEADING_GAP = 32;
// VS Code が窓の右下に出す通知の要素。
const NOTIFICATION_SELECTOR = '.notification-toast';

/**
 * 文字列を HTML の本文と属性値に置けるよう逃がす。
 *
 * @param {string} text 文字列。
 * @returns {string} 逃がした文字列。
 */
function escapeHtml(text) {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

/**
 * バナー 1 枚分の HTML を作る。ヘッダーは下辺を、フッターは上辺を波形にした帯で、ヘッダーだけが文言を持つ。
 *
 * @param {{ kind: 'header' | 'footer', title?: string, tagline?: string }} options バナーの種類と文言。
 * @returns {string} Chromium で開いて撮る HTML。背景は透明にする。
 */
export function renderBannerHtml({ kind, title = '', tagline = '' }) {
  const width = BANNER_WIDTH;
  const isHeader = kind === 'header';
  const height = isHeader ? HEADER_HEIGHT : FOOTER_HEIGHT;
  // 奥の波を薄く重ね、手前の波との差で奥行きを出す。
  const waves = isHeader
    ? [
        `M0 0H${width}V172C1090 214 930 128 720 160S330 214 0 150Z`,
        `M0 0H${width}V150C1060 196 900 112 690 146S300 196 0 132Z`,
      ]
    : [
        `M0 42C210 4 380 76 610 40S1040 6 ${width} 48V${height}H0Z`,
        `M0 64C230 26 420 96 650 60S1060 30 ${width} 70V${height}H0Z`,
      ];
  // フッターはヘッダーと逆向きのグラデーションにして、上下で対になるようにする。
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
 * 画面の無い Linux では Xvfb を起動し、VS Code に渡す環境変数を返す。
 *
 * @returns {Promise<{ env: Record<string, string>, stop: () => void }>} 足す環境変数と、Xvfb を止める関数。
 */
async function ensureDisplay() {
  if (process.platform !== 'linux' || process.env.DISPLAY) {
    return { env: {}, stop: () => {} };
  }
  // -displayfd で空いている番号を Xvfb に選ばせ、決まった番号を 3 番目の出力で受け取る。
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
    xvfb.on('error', (error) => reject(new Error(`画面が無く、Xvfb も起動できない：${error.message}`)));
    xvfb.on('exit', (code) => reject(new Error(`Xvfb が終了した（終了コード ${code}）`)));
  });
  return { env: { DISPLAY: `:${display}` }, stop: () => xvfb.kill() };
}

/**
 * 撮影に使う VS Code の実行ファイルを探す。統合テストと同じ順に探し、無ければ同じ版を取得する。
 *
 * @returns {Promise<string>} 実行ファイルのパス。
 */
async function findVsCode() {
  const installed = [process.env.AHVE_VSCODE_EXECUTABLE, LINUX_VSCODE_EXECUTABLE].find(
    (candidate) => candidate && existsSync(candidate),
  );
  if (installed) {
    return installed;
  }
  const { downloadAndUnzipVSCode } = await import('@vscode/test-electron');
  return downloadAndUnzipVSCode(VSCODE_VERSION);
}

/**
 * 撮影用の VS Code の利用者設定。拡張と関係の無い UI を隠し、HTML を最初から WYSIWYG で開く。
 *
 * @param {'light' | 'dark'} theme 色のテーマ。
 * @returns {Record<string, unknown>} settings.json の内容。
 */
function vsCodeSettings(theme) {
  return {
    'workbench.colorTheme': theme === 'dark' ? 'Default Dark Modern' : 'Default Light Modern',
    'workbench.editorAssociations': { '*.html': 'ahve.editor' },
    'workbench.startupEditor': 'none',
    'workbench.tips.enabled': false,
    'workbench.secondarySideBar.defaultVisibility': 'hidden',
    // タイトルバーは OS が描く形にし、撮る範囲（窓の中身）に入れない。
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
 * VS Code を一時ディレクトリの利用者データで起動し、見本の文書を WYSIWYG で開く。
 *
 * @param {{ electron: import('@playwright/test').Electron, executable: string, workDir: string, theme: 'light' | 'dark', env: Record<string, string> }} options
 *   Playwright の Electron、VS Code の実行ファイル、作業ディレクトリ、色のテーマ、足す環境変数。
 * @returns {Promise<{ app: import('@playwright/test').ElectronApplication, page: import('@playwright/test').Page, editor: import('@playwright/test').Frame }>}
 *   起動した VS Code、その窓、WYSIWYG の文書を持つフレーム。
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
      // コンテナの root や Xvfb でも起動できるようにする。GPU の無い画面では GPU を使わない。
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
  // 撮る前に失敗しても VS Code を閉じる。閉じないと窓が残り、画面のある環境では理由を出した後もスクリプトが終わらない。
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
    // 閉じるのに失敗しても、利用者に見せるのは撮れなかった理由のほうである。
    await app.close().catch(() => {});
    throw error;
  }
}

/**
 * WYSIWYG の文書を持つフレームが現れるまで待つ。webview は入れ子のフレームなので、見出しの目印で探す。
 *
 * @param {import('@playwright/test').Page} page VS Code の窓。
 * @returns {Promise<import('@playwright/test').Frame>} 文書を持つフレーム。
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
        // 読み込み直後のちらつきが収まるのを待ってから撮る。
        await page.waitForTimeout(1500);
        return frame;
      }
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`${SAMPLE_FILE} が WYSIWYG で開かなかった。`);
}

/**
 * 通知を消す。root で動かすと出る警告のように、拡張と関係の無い通知を写さないためである。
 * root の警告は文書が開いた後に遅れて出ることがあり、消した後に出ると写り込むので、出るのを待ってから消す。
 *
 * @param {import('@playwright/test').Page} page VS Code の窓。
 */
async function clearNotifications(page) {
  if (process.getuid?.() === 0) {
    // 待っても出なければ、消すものが無いだけなので、そのまま進む。
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
 * コマンドパレットを開く。F1 は webview にフォーカスがあっても VS Code へ渡るが、フォーカスが移る途中に押すと
 * 取りこぼされることがあるので、開いたのを確かめ、開かなければ押し直す。開かないまま文字を打つと文字が webview に
 * 入り、空白のたびに文書がスクロールする。
 *
 * @param {import('@playwright/test').Page} page VS Code の窓。
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
  throw new Error('コマンドパレットが開かず、通知を消せない。');
}

/**
 * 複数の要素を囲む範囲に余白を足し、窓からはみ出さないように切り詰める。
 *
 * @param {Array<{ x: number, y: number, width: number, height: number } | null>} boxes 要素の範囲。
 * @param {number} [margin] 周りに残す余白。隣の文や見出しの切れ端が写るときは狭くする。
 * @returns {{ x: number, y: number, width: number, height: number }} 切り抜く範囲。
 */
function unionClip(boxes, margin = CROP_MARGIN) {
  const present = boxes.filter((box) => box !== null);
  if (present.length === 0) {
    throw new Error('切り抜く要素が見つからない。');
  }
  const left = Math.max(0, Math.min(...present.map((box) => box.x)) - margin);
  const top = Math.max(0, Math.min(...present.map((box) => box.y)) - margin);
  const right = Math.min(WINDOW_SIZE.width, Math.max(...present.map((box) => box.x + box.width)) + margin);
  const bottom = Math.min(WINDOW_SIZE.height, Math.max(...present.map((box) => box.y + box.height)) + margin);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * 切り抜きの下端にかかった 1 行ぶんの要素を、その下端まで含める。文字が上下に切れていると、撮り損ないに見えるためである。
 *
 * @param {import('@playwright/test').Frame} editor WYSIWYG の文書を持つフレーム。
 * @param {{ x: number, y: number, width: number, height: number }} clip 切り抜く範囲。
 * @returns {Promise<{ x: number, y: number, width: number, height: number }>} 下端を広げた範囲。
 */
async function includeCutLines(editor, clip) {
  const bottom = clip.y + clip.height;
  let extended = bottom;
  for (const line of await editor.locator('h1, h2, h3, p, li, summary, tr').all()) {
    const box = await line.boundingBox();
    // 表や図のような高さのある塊は、切れていても何の画像かは分かるので広げない。
    if (box !== null && box.height < 60 && box.y < bottom && box.y + box.height > bottom) {
      extended = Math.max(extended, box.y + box.height);
    }
  }
  return { ...clip, height: Math.min(WINDOW_SIZE.height, extended) - clip.y };
}

/**
 * 切り抜く範囲が、文書の見えている範囲に収まっているかを確かめる。上端がツールバーの下端より上ならツールバーや
 * VS Code のタブの帯が、下端が webview の下端より下なら VS Code のステータスバーが写る。どちらも文書のスクロールが
 * ずれたときに起きる撮り損ないなので、撮る前に理由を出して止める。
 *
 * @param {string} name 書き出す画像のファイル名。例外の理由に含める。
 * @param {{ x: number, y: number, width: number, height: number }} clip 切り抜く範囲。
 * @param {{ top: number, bottom: number }} view 文書の見えている範囲（ツールバーの下端と webview の下端）。
 */
export function assertClipInView(name, clip, view) {
  if (clip.y < view.top) {
    throw new Error(
      `${name} を撮れない：切り抜く範囲の上端（${clip.y}）がツールバーの下端（${view.top}）より上にあり、ツールバーが写る。`,
    );
  }
  if (clip.y + clip.height > view.bottom) {
    throw new Error(
      `${name} を撮れない：切り抜く範囲の下端（${clip.y + clip.height}）が webview の下端（${view.bottom}）より下にあり、` +
        'VS Code の画面が写る。',
    );
  }
}

/**
 * 文書の見えている範囲の上端と下端を、窓の座標で返す。上端はスクロールしても上に留まるツールバーの下端、下端は
 * webview の下端である。
 *
 * @param {import('@playwright/test').Frame} editor WYSIWYG の文書を持つフレーム。
 * @returns {Promise<{ top: number, bottom: number }>} 見えている範囲。
 */
async function readDocumentView(editor) {
  const toolbar = await editor.locator(TOOLBAR_SELECTOR).boundingBox();
  const frame = await (await editor.frameElement()).boundingBox();
  if (toolbar === null || frame === null) {
    throw new Error('ツールバーか webview の位置を読めない。');
  }
  return { top: toolbar.y + toolbar.height, bottom: frame.y + frame.height };
}

/**
 * 見出しの上端がツールバーの下端から HEADING_GAP だけ下に来るよう、文書をスクロールする。ツールバーはスクロールしても
 * 上端に留まるため、表示領域の上端へ揃えると見出しがその下に隠れる。文書の末尾の近くではスクロールが足りず、見出しは
 * それより下に残る。
 *
 * @param {import('@playwright/test').Locator} heading 見出し。
 */
async function alignBelowToolbar(heading) {
  await heading.evaluate(
    (element, { selector, gap }) => {
      const toolbar = element.ownerDocument.querySelector(selector);
      if (toolbar === null) {
        throw new Error('ツールバーが見つからない。');
      }
      const offset = element.getBoundingClientRect().top - toolbar.getBoundingClientRect().bottom - gap;
      element.ownerDocument.defaultView?.scrollBy(0, offset);
    },
    { selector: TOOLBAR_SELECTOR, gap: HEADING_GAP },
  );
}

/**
 * VS Code の通知が出ていないことを確かめる。通知は窓の右下に重なるので、出ていれば拡張と関係の無い UI が写る。
 *
 * @param {import('@playwright/test').Page} page VS Code の窓。
 * @param {string} name 書き出す画像のファイル名。例外の理由に含める。
 */
async function assertNoNotifications(page, name) {
  const shown = await page.locator(NOTIFICATION_SELECTOR).filter({ visible: true }).allInnerTexts();
  if (shown.length > 0) {
    throw new Error(`${name} を撮れない：VS Code の通知が出ていて、写り込む（${shown.join('／')}）。`);
  }
}

/**
 * 通知が出ていないことを確かめてから、窓の全体を撮る。
 *
 * @param {import('@playwright/test').Page} page VS Code の窓。
 * @param {string} outputDir 書き出すディレクトリ。
 * @param {string} name 書き出す画像のファイル名。
 */
async function captureWindow(page, outputDir, name) {
  await assertNoNotifications(page, name);
  await page.screenshot({ path: join(outputDir, name) });
}

/**
 * 切り抜く範囲が文書の見えている範囲に収まり、通知が出ていないことを確かめてから、その範囲を撮る。
 *
 * @param {{ page: import('@playwright/test').Page, editor: import('@playwright/test').Frame }} screen VS Code の窓と、
 *   WYSIWYG の文書を持つフレーム。
 * @param {string} outputDir 書き出すディレクトリ。
 * @param {string} name 書き出す画像のファイル名。
 * @param {{ x: number, y: number, width: number, height: number }} clip 切り抜く範囲。
 */
async function captureClip({ page, editor }, outputDir, name, clip) {
  assertClipInView(name, clip, await readDocumentView(editor));
  await assertNoNotifications(page, name);
  await page.screenshot({ path: join(outputDir, name), clip });
}

/**
 * バナー 2 枚を Chromium で PNG にする。
 *
 * @param {import('@playwright/test').BrowserType} chromium Playwright の Chromium。
 * @param {string} outputDir 書き出すディレクトリ。
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
 * ライトの配色で、全体・コメント・表の 3 枚を撮る。
 *
 * @param {Parameters<typeof openSample>[0]} options VS Code の起動に渡すもの。
 * @param {string} outputDir 書き出すディレクトリ。
 */
async function captureLightScreens(options, outputDir) {
  const { app, page, editor } = await openSample({ ...options, theme: 'light' });
  try {
    // 全体：サイドバーで見出しとコメントの一覧を開き、コメントのスレッドを開いた状態にする。
    await editor.getByRole('button', { name: 'Sidebar', exact: true }).click();
    const target = editor.locator(`comment#${SAMPLE_COMMENT_ID}`);
    await target.click();
    const popup = editor.getByRole('dialog', { name: 'Comment Thread' });
    await popup.waitFor({ state: 'visible' });
    await page.waitForTimeout(600);
    await captureWindow(page, outputDir, 'overview.png');

    // コメント：注釈の付いた文と、開いたスレッドを切り抜く。
    const paragraph = editor.locator('p', { has: target });
    await captureClip(
      { page, editor },
      outputDir,
      'comments.png',
      await includeCutLines(editor, unionClip([await paragraph.boundingBox(), await popup.boundingBox()])),
    );
    await page.keyboard.press('Escape');

    // 表：表をツールバーのすぐ下まで送り、メニューが下へ開くようにしてから、セルを右クリックして表の操作の
    // メニューを開く。上へずれて開いたメニューが図に重なると、何を撮った画像か分からなくなるためである。
    const heading = editor.locator('h2', { hasText: 'Options Compared' });
    await alignBelowToolbar(heading);
    const table = editor.locator('table').first();
    await table.locator('td').nth(2).click({ button: 'right' });
    const menu = editor.getByRole('menu', { name: 'Table Actions' });
    await menu.waitFor({ state: 'visible' });
    await page.waitForTimeout(400);
    // 見出しの上にある図の枠が入らないよう、余白を狭くする。
    await captureClip(
      { page, editor },
      outputDir,
      'tables.png',
      await includeCutLines(
        editor,
        unionClip([await heading.boundingBox(), await table.boundingBox(), await menu.boundingBox()], 12),
      ),
    );
  } finally {
    await app.close();
  }
}

/**
 * ダークの配色で、Mermaid の図を撮る。図が VS Code の配色に従うことを見せるため、ダークで撮る。
 *
 * @param {Parameters<typeof openSample>[0]} options VS Code の起動に渡すもの。
 * @param {string} outputDir 書き出すディレクトリ。
 */
async function captureDarkScreens(options, outputDir) {
  const { app, page, editor } = await openSample({ ...options, theme: 'dark' });
  try {
    const diagram = editor.locator('pre.mermaid').first();
    // 図は pre の ::after に背景の画像として描かれる。描き終わると図の高さが変わるので、待ってから位置を決める。
    await diagram.evaluate(
      (element) =>
        new Promise((resolve, reject) => {
          const started = Date.now();
          const poll = () => {
            if (getComputedStyle(element, '::after').backgroundImage.startsWith('url(')) {
              resolve(undefined);
            } else if (Date.now() - started > 30_000) {
              reject(new Error('Mermaid の図が描かれなかった。'));
            } else {
              setTimeout(poll, 200);
            }
          };
          poll();
        }),
    );
    // 見出しをツールバーのすぐ下まで送る。開いたときの位置のまま撮ると、文書がスクロールしていれば見出しが
    // ツールバーの下に隠れる。
    const heading = editor.locator('h2', { hasText: 'Flow' });
    await alignBelowToolbar(heading);
    await page.waitForTimeout(600);
    // 見出しの上の段落と、図の下の見出しの切れ端が入らないよう、余白を狭くする。
    await captureClip(
      { page, editor },
      outputDir,
      'diagrams.png',
      unionClip([await heading.boundingBox(), await diagram.boundingBox()], 8),
    );
  } finally {
    await app.close();
  }
}

/**
 * バナーを描いて画面を撮り、揃ったものだけを assets/readme/ へ写す。
 *
 * @returns {Promise<number>} 終了コード。
 */
async function main() {
  if (!existsSync(join(REPOSITORY_ROOT, 'dist', 'extension.js'))) {
    console.error('dist/ が無い。npm run readme:images で、ビルドしてから流す。');
    return 1;
  }
  const { chromium, _electron: electron } = await import('@playwright/test');
  // VS Code は利用者データの下にソケットを作り、そのパスは 107 文字までなので、短い一時ディレクトリに置く。
  const workDir = mkdtempSync(join(tmpdir(), 'ahve-readme-'));
  const staging = join(workDir, 'images');
  mkdirSync(staging);
  let display;
  try {
    display = await ensureDisplay();
    await renderBanners(chromium, staging);
    const options = { electron, executable: await findVsCode(), workDir, env: display.env };
    await captureLightScreens(options, staging);
    await captureDarkScreens(options, staging);

    // 途中で失敗したときに、古い画像と新しい画像が混ざらないよう、全部そろってから書き換える。
    mkdirSync(OUTPUT_DIR, { recursive: true });
    const files = readdirSync(staging).sort();
    for (const file of files) {
      copyFileSync(join(staging, file), join(OUTPUT_DIR, file));
    }
    console.log(`assets/readme/ に ${files.length} 枚の画像を書いた：${files.join('、')}`);
    return 0;
  } finally {
    display?.stop();
    rmSync(workDir, { recursive: true, force: true });
  }
}

// テストから読み込まれたときは撮らず、直接実行されたときだけ動く。Node.js は自身の URL をシンボリックリンクを
// 解いた実体のパスで持つので、起動したパスも実体に直して比べる。直さないと、リンク越しの起動で何もせずに終わる。
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
