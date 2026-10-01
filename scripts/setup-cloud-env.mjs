// Prepares a cloud session (an isolated Linux VM, as used by claude.ai/code) to run the three test layers.
//
// This script supplies only what the VM lacks.
//
// | Missing piece | Default source | Alternative used here |
// | --- | --- | --- |
// | VS Code itself (integration) | update.code.visualstudio.com | packages.microsoft.com (apt) |
// | Chromium (E2E) | cdn.playwright.dev | storage.googleapis.com (Chrome for Testing) |
// | xvfb (launching Electron) | apt | apt |
//
// The alternatives exist because the default sources are not in the cloud environment's allowed domains.
// Where they are allowed, the default route works and this script changes nothing.
//
// It is idempotent, so it returns at once when everything is present. Installing assumes root; without it
// the install steps are skipped.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The same location .vscode-test.mjs falls back to. The apt build of VS Code lands here.
const VSCODE_EXECUTABLE = '/usr/share/code/code';
const MICROSOFT_KEY_URL = 'https://packages.microsoft.com/keys/microsoft.asc';
const MICROSOFT_KEYRING = '/usr/share/keyrings/microsoft-archive-keyring.gpg';
const VSCODE_APT_LIST = '/etc/apt/sources.list.d/vscode.list';

// Playwright's Chromium is a redistribution of Chrome for Testing, so a CfT url on cdn.playwright.dev
// can be swapped for Google's public bucket, which holds the very same archive.
const PLAYWRIGHT_CFT_PREFIX = 'https://cdn.playwright.dev/builds/cft/';
const GOOGLE_CFT_PREFIX = 'https://storage.googleapis.com/chrome-for-testing-public/';

let aptUpdated = false;

function log(message) {
  console.log(`[setup-cloud-env] ${message}`);
}

function isRoot() {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

function hasCommand(name) {
  return spawnSync('which', [name], { stdio: 'ignore' }).status === 0;
}

function run(command, commandArguments, options = {}) {
  const result = spawnSync(command, commandArguments, { stdio: 'inherit', ...options });
  return result.status === 0;
}

// Refreshing the apt index once is enough. A failure is not fatal: the VM may carry PPAs that are not
// allowed, and the run can go on as long as the repositories that matter were fetched.
function aptUpdate() {
  if (aptUpdated) {
    return;
  }
  run('apt-get', ['update', '-qq']);
  aptUpdated = true;
}

function aptInstall(packages) {
  aptUpdate();
  return run('apt-get', ['install', '-y', '--no-install-recommends', ...packages], {
    env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' },
  });
}

// --- xvfb -------------------------------------------------------------------

// Electron does not start without a display, so without this not a single integration test runs.
function ensureXvfb() {
  if (hasCommand('xvfb-run')) {
    log('xvfb: already installed');
    return true;
  }
  if (!isRoot()) {
    log('xvfb: missing, but skipped because this is not root');
    return false;
  }
  log('xvfb: installing through apt');
  return aptInstall(['xvfb']);
}

// --- VS Code ----------------------------------------------------------------

// Registers Microsoft's apt repository, storing the signing key as a dearmored keyring.
function registerMicrosoftRepository() {
  if (!existsSync(MICROSOFT_KEYRING)) {
    const armoredKey = execFileSync('curl', ['-fsSL', '-m', '60', MICROSOFT_KEY_URL]);
    const dearmored = execFileSync('gpg', ['--dearmor'], { input: armoredKey, maxBuffer: 1024 * 1024 });
    writeFileSync(MICROSOFT_KEYRING, dearmored);
  }
  const entry = `deb [arch=amd64 signed-by=${MICROSOFT_KEYRING}] https://packages.microsoft.com/repos/code stable main\n`;
  writeFileSync(VSCODE_APT_LIST, entry);
  // A repository was added, so the index has to be fetched again.
  aptUpdated = false;
}

function ensureVsCode() {
  if (existsSync(VSCODE_EXECUTABLE)) {
    log(`VS Code: already installed (${VSCODE_EXECUTABLE})`);
    return true;
  }
  if (!isRoot()) {
    log('VS Code: missing, but skipped because this is not root');
    return false;
  }
  log('VS Code: installing from packages.microsoft.com through apt');
  try {
    registerMicrosoftRepository();
  } catch (error) {
    log(`VS Code: could not register the repository (${error.message})`);
    return false;
  }
  // Its dependencies cover the GTK and NSS families, so Electron's shared libraries arrive with it.
  if (!aptInstall(['code'])) {
    log('VS Code: the apt install failed');
    return false;
  }
  return existsSync(VSCODE_EXECUTABLE);
}

// --- Playwright's Chromium --------------------------------------------------

// playwright install --dry-run prints the target directory and download url of every build it needs.
// Reading the versions from there means a lockfile bump does not have to be mirrored in this script.
function readPlaywrightPlan() {
  const result = spawnSync('npx', ['playwright', 'install', '--dry-run', 'chromium'], { encoding: 'utf8' });
  if (result.status !== 0) {
    return [];
  }
  const plan = [];
  let current = null;
  for (const line of result.stdout.split('\n')) {
    const location = line.match(/^\s*Install location:\s*(\S+)/);
    if (location) {
      current = { directory: location[1], url: null };
      plan.push(current);
      continue;
    }
    const url = line.match(/^\s*Download url:\s*(\S+)/);
    if (url && current && !current.url) {
      current.url = url[1];
    }
  }
  return plan;
}

// Playwright marks a build as installed by placing INSTALLATION_COMPLETE in its directory.
function isBrowserInstalled(directory) {
  return existsSync(join(directory, 'INSTALLATION_COMPLETE'));
}

// Unpacks a zip into the target directory and leaves the installed marker behind. The archive already
// carries the layout Playwright expects, such as chrome-linux64/, so it opens straight into the target.
function installFromZip(directory, url) {
  const workDirectory = mkdtempSync(join(tmpdir(), 'ahve-cft-'));
  const archive = join(workDirectory, 'browser.zip');
  try {
    if (!run('curl', ['-fsSL', '-m', '900', '-o', archive, url])) {
      return false;
    }
    mkdirSync(directory, { recursive: true });
    if (!run('unzip', ['-q', '-o', archive, '-d', directory])) {
      return false;
    }
    writeFileSync(join(directory, 'INSTALLATION_COMPLETE'), '');
    return true;
  } finally {
    rmSync(workDirectory, { recursive: true, force: true });
  }
}

function ensureChromium() {
  const plan = readPlaywrightPlan();
  if (plan.length === 0) {
    log('Chromium: could not read playwright install --dry-run');
    return false;
  }
  // ffmpeg does not come from CfT, so no alternative source exists for it. Tests that record no video
  // never touch it. Leaving it out of this check stops a download attempt on every run where it is absent.
  const required = plan.filter((entry) => entry.url?.startsWith(PLAYWRIGHT_CFT_PREFIX));
  if (required.length > 0 && required.every((entry) => isBrowserInstalled(entry.directory))) {
    log('Chromium: already installed');
    return true;
  }

  // Try the official route first. Where the domains are allowed this completes the job and nothing below
  // runs. Where they are not, it only repeats a 403, so the output is dropped and just the result is read.
  log('Chromium: trying playwright install');
  if (run('npx', ['playwright', 'install', 'chromium'], { stdio: 'ignore' })) {
    log('Chromium: playwright install succeeded');
    return true;
  }
  log('Chromium: the default source is unreachable, switching to the alternative source');

  if (!hasCommand('unzip') && isRoot()) {
    aptInstall(['unzip']);
  }
  if (!hasCommand('unzip')) {
    log('Chromium: the alternative route needs unzip, which is missing');
    return false;
  }

  // The fallback for an unreachable cdn.playwright.dev. Only CfT builds come from Google's bucket.
  let complete = true;
  for (const entry of plan) {
    if (isBrowserInstalled(entry.directory)) {
      continue;
    }
    if (!entry.url || !entry.url.startsWith(PLAYWRIGHT_CFT_PREFIX)) {
      // ffmpeg is not a CfT build, so it has no alternative. Tests that record no video never use it,
      // which is why its absence is not treated as a failure.
      log(`Chromium: ${entry.directory} is outside the alternative route, skipping it`);
      continue;
    }
    const alternativeUrl = GOOGLE_CFT_PREFIX + entry.url.slice(PLAYWRIGHT_CFT_PREFIX.length);
    log(`Chromium: fetching from ${alternativeUrl}`);
    if (!installFromZip(entry.directory, alternativeUrl)) {
      log(`Chromium: could not place ${entry.directory}`);
      complete = false;
    }
  }
  return complete;
}

// --- Run --------------------------------------------------------------------

const results = [
  ['xvfb', ensureXvfb()],
  ['VS Code', ensureVsCode()],
  ['Chromium', ensureChromium()],
];

const missing = results.filter(([, ready]) => !ready).map(([name]) => name);
if (missing.length > 0) {
  // Even with something missing the other layers still run. Naming what is absent lets the caller work
  // out which layer will fail, so the exit code stays 0.
  log(`Missing: ${missing.join(', ')}`);
} else {
  log('Everything is in place');
}
