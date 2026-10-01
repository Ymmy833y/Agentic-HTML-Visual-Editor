import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Frame, Page } from '@playwright/test';
import { buildWebviewContent } from '../../../src/editor/webview-content';
import { installStubHost } from './stub-host';

// Playwright loads test code as CommonJS, so __dirname is available.
// Every path is resolved from here so that nothing depends on the working directory at launch.
const HELPERS_DIR = __dirname;
const FIXTURE_PATH = path.resolve(HELPERS_DIR, '../fixtures/webview-host.html');
// A page that hosts the view in a frame and places an input field outside the frame.
const FRAMED_FIXTURE_PATH = path.resolve(HELPERS_DIR, '../fixtures/framed-webview-host.html');
const DEFAULT_BUNDLE_PATH = path.resolve(HELPERS_DIR, '../../../dist/webview.js');
// Only the cases that read the view's body output use the e2e-only bundle, which adds
// the read-only entry point.
export const PROBE_BUNDLE_PATH = path.resolve(HELPERS_DIR, '../../../dist/webview-probe.js');
const STYLESHEET_PATH = path.resolve(HELPERS_DIR, '../../../dist/webview.css');

const STUB_HOST_MISSING = 'the stub host is not installed';

// The locations of the fixture page and its containing directory. Tests for relative path
// resolution use these as the two base URIs supplied by the host.
export const FIXTURE_PAGE_URL = pathToFileURL(FIXTURE_PATH).href;
export const FIXTURE_DIRECTORY_URL = pathToFileURL(path.resolve(HELPERS_DIR, '../fixtures') + path.sep).href;

// Opens a fixture with only the stub host installed, without loading the bundle. The bundle acquires
// the VS Code API when loaded, and the API can be acquired only once. Tests that access the stub host
// API itself use this bundle-free page.
export async function openStubHost(page: Page): Promise<void> {
  // The initialization script installs acquireVsCodeApi before any script on the page runs.
  await page.addInitScript(installStubHost);
  await page.goto(FIXTURE_PAGE_URL);
}

// Loads the webview bundle into the fixture page that has the stub installed.
export async function openWebviewHost(page: Page, bundlePath: string = DEFAULT_BUNDLE_PATH): Promise<void> {
  await openStubHost(page);
  // Load the bundled stylesheet before the bundle. Without it, tests for default styles would pass
  // without verifying any styles. Do not use a link in the fixture page: as with the bundle, a load
  // failure is silently ignored under the file: scheme.
  await page.addStyleTag({ path: STYLESHEET_PATH });
  // Do not load the bundle from a <script src> in the fixture page: under the file: scheme a load
  // failure is silently ignored, and a broken bundle would let the test pass green (detailed design §3.7).
  // Adding it here makes a bundle that is missing, or that fails to evaluate, throw.
  await page.addScriptTag({ path: bundlePath });
}

// A made-up origin that stands in for the webview source. Requests to it are answered from the build output, so the
// page loads the bundle and the stylesheet under the same content security policy as in VS Code.
export const PRODUCTION_PAGE_ORIGIN = 'https://ahve.test';
const PRODUCTION_PAGE_URL = `${PRODUCTION_PAGE_ORIGIN}/index.html`;
const PRODUCTION_PAGE_NONCE = 'e2e-nonce';

// Opens the document the extension writes to the panel, content security policy included, with the stub host
// installed. The fixture page has no policy, so what the policy blocks can only be seen on this page.
export async function openProductionWebviewHost(page: Page): Promise<void> {
  await page.addInitScript(installStubHost);
  const document = buildWebviewContent(
    PRODUCTION_PAGE_ORIGIN,
    PRODUCTION_PAGE_NONCE,
    `${PRODUCTION_PAGE_ORIGIN}/dist/webview.js`,
    `${PRODUCTION_PAGE_ORIGIN}/dist/webview.css`,
    { locale: 'en', catalog: {} },
  );
  const files: Record<string, { path: string; contentType: string }> = {
    '/dist/webview.js': { path: DEFAULT_BUNDLE_PATH, contentType: 'text/javascript' },
    '/dist/webview.css': { path: STYLESHEET_PATH, contentType: 'text/css' },
  };
  await page.route(`${PRODUCTION_PAGE_ORIGIN}/**`, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const file = files[pathname];
    if (file !== undefined) {
      await route.fulfill({ body: await readFile(file.path), contentType: file.contentType });
      return;
    }
    await route.fulfill(pathname === '/index.html'
      ? { body: document, contentType: 'text/html' }
      : { status: 404, body: '' });
  });
  await page.goto(PRODUCTION_PAGE_URL);
}

// Opens the framed page and loads the e2e-only bundle into the frame.
// The stub also enters the frame as an initialization script. Moving focus to the input field
// outside the frame makes the view lose focus.
export async function openFramedWebviewHost(page: Page): Promise<Frame> {
  await page.addInitScript(installStubHost);
  await page.goto(pathToFileURL(FRAMED_FIXTURE_PATH).href);
  const frame = page.frame({ url: FIXTURE_PAGE_URL });
  if (frame === null) {
    throw new Error('The view frame has not loaded');
  }
  await frame.addStyleTag({ path: STYLESHEET_PATH });
  await frame.addScriptTag({ path: PROBE_BUNDLE_PATH });
  return frame;
}

// Passes a message to the view inside the frame as if it had arrived from the host.
export async function sendToFrame(frame: Frame, message: unknown): Promise<void> {
  await frame.evaluate((argument: { payload: unknown; missing: string }) => {
    const stubHost = window.__stubHost;
    if (!stubHost) {
      throw new Error(argument.missing);
    }
    stubHost.inject(argument.payload);
  }, { payload: message, missing: STUB_HOST_MISSING });
}

// Takes out the messages the webview sent to the host, in the order they were sent.
export async function getOutboundMessages(page: Page): Promise<unknown[]> {
  return page.evaluate((message) => {
    const stubHost = window.__stubHost;
    if (!stubHost) {
      throw new Error(message);
    }
    return stubHost.record;
  }, STUB_HOST_MISSING);
}

// Sets whether sending to the host fails.
export async function setSendFailure(page: Page, failing: boolean): Promise<void> {
  await page.evaluate((argument: { failing: boolean; missing: string }) => {
    const stubHost = window.__stubHost;
    if (!stubHost) {
      throw new Error(argument.missing);
    }
    stubHost.failSend = argument.failing;
  }, { failing, missing: STUB_HOST_MISSING });
}

// Fails delivery only for the specified types. An empty array restores successful delivery for every type.
export async function setSendFailureTypes(page: Page, types: string[]): Promise<void> {
  await page.evaluate((argument: { types: string[]; missing: string }) => {
    const stubHost = window.__stubHost;
    if (!stubHost) {
      throw new Error(argument.missing);
    }
    stubHost.failSendTypes = argument.types;
  }, { types, missing: STUB_HOST_MISSING });
}

// Delivers a message from the host to the webview.
export async function sendToWebview(page: Page, message: unknown): Promise<void> {
  await page.evaluate((argument: { payload: unknown; missing: string }) => {
    const stubHost = window.__stubHost;
    if (!stubHost) {
      throw new Error(argument.missing);
    }
    stubHost.inject(argument.payload);
  }, { payload: message, missing: STUB_HOST_MISSING });
}

/**
 * Reads a color token of the toolbar under the theme currently applied.
 *
 * The toolbar and the floating menu draw with tints and softened colors rather than with theme colors themselves, so
 * specs compare against the toolbar's own tokens (`--bar-hover`, `--bar-on` and the like) instead of repeating their
 * mixes. The token is resolved on a probe element placed in the toolbar, so that it is read the way an item reads it.
 *
 * @param page The page the view is mounted in.
 * @param token The custom property name, such as `--bar-hover`.
 * @returns The computed color.
 */
export async function readToolbarColorToken(page: Page, token: string): Promise<string> {
  return page.evaluate((name) => {
    const toolbar = document.getElementById('editor-toolbar');
    if (toolbar === null) {
      throw new Error('The toolbar is not mounted');
    }
    const probe = document.createElement('span');
    probe.style.color = `var(${name})`;
    toolbar.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, token);
}

/**
 * Reads the color the toolbar draws an idle icon in under the theme currently applied. The icons are drawn in a
 * softened foreground rather than the foreground itself.
 *
 * @param page The page the view is mounted in.
 * @returns The computed color.
 */
export async function readIdleIconColor(page: Page): Promise<string> {
  return readToolbarColorToken(page, '--bar-icon');
}

/** What a spec reads in place of an icon stroke that is exactly the idle icon color. */
export const IDLE_ICON_COLOR = 'the idle icon color';

/**
 * Names a stroke as the idle icon color when it is exactly that, and returns it unchanged otherwise.
 *
 * @param page The page the view is mounted in.
 * @param stroke The computed stroke of an icon.
 * @returns {@link IDLE_ICON_COLOR} or the stroke.
 */
export async function nameIconStroke(page: Page, stroke: string): Promise<string> {
  return stroke === await readIdleIconColor(page) ? IDLE_ICON_COLOR : stroke;
}
