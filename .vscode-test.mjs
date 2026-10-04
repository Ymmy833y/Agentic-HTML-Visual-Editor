import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defineConfig } from '@vscode/test-cli';

const userDataDir = join(tmpdir(), `ahve-vscode-test-${process.pid}`);

// Where VS Code's distribution source (update.code.visualstudio.com) is unreachable, an installation
// that is already on the machine is used instead. The default candidate is where
// scripts/setup-cloud-env.mjs puts the apt build; setting AHVE_VSCODE_EXECUTABLE takes precedence.
// With neither present this falls back to downloading `version`, leaving ordinary environments alone.
const executableCandidates = [process.env.AHVE_VSCODE_EXECUTABLE, '/usr/share/code/code'];
const installedExecutable = executableCandidates.find((candidate) => candidate && existsSync(candidate));

// Integration layer configuration.
export default defineConfig({
  files: 'out-test/suite/**/*.test.js',
  // Pinned rather than 'stable' so that every run tests against the same build. With 'stable' the
  // build under test changes on every VS Code release day, without any change to this repository.
  version: '1.140.0',
  ...(installedExecutable ? { useInstallation: { fromPath: installedExecutable } } : {}),
  workspaceFolder: 'tests/integration/fixtures',
  launchArgs: ['--user-data-dir', userDataDir],
  mocha: {
    ui: 'bdd',
    timeout: 60000,
  },
});
