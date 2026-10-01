// Launcher for the integration layer.
//
// @vscode/test-electron starts a real VS Code (Electron), which on Linux needs an X display. Where Linux
// has none, as on CI and in cloud sessions, the run is wrapped in xvfb-run. Everywhere else — Windows,
// macOS, or a Linux with a display — vscode-test starts directly.
//
// The point is that callers need not spell the command differently per environment: `npm run
// test:integration` is the same everywhere.

import { spawnSync } from 'node:child_process';

// vscode-test is a shell wrapper under .bin, so on Windows it only starts through a shell.
const VSCODE_TEST = 'vscode-test';

// Whether this is a Linux without a display. Only then is xvfb-run inserted.
function needsVirtualDisplay() {
  if (process.platform !== 'linux') {
    return false;
  }
  if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) {
    return false;
  }
  // Inserting it where xvfb-run is absent would break the launch itself, so confirm it exists first.
  return spawnSync('which', ['xvfb-run'], { stdio: 'ignore' }).status === 0;
}

const forwardedArguments = process.argv.slice(2);

// -a lets xvfb-run pick a display number that is free, so parallel runs do not collide on one.
const [command, commandArguments] = needsVirtualDisplay()
  ? ['xvfb-run', ['-a', VSCODE_TEST, ...forwardedArguments]]
  : [VSCODE_TEST, forwardedArguments];

const result = spawnSync(command, commandArguments, { stdio: 'inherit', shell: process.platform === 'win32' });

if (result.error) {
  console.error(`Could not start ${command}: ${result.error.message}`);
  process.exit(1);
}

// A process killed by a signal reports a null status. That is not a passing run, so it counts as a failure.
process.exit(result.status ?? 1);
