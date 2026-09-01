import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REQUIRED_PACKAGE_FILES = [
  'dist/extension.js',
  'dist/webview.js',
  'dist/webview.css',
  'dist/mermaid.js',
  'assets/icon.png',
  'icons/ahve-dark.svg',
  'icons/ahve-light.svg',
  'package.json',
  'README.md',
  'README_ja.md',
  'CHANGELOG.md',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
];

describe('.vscodeignore package allowlist', () => {
  it('excludes everything by default and includes only required extension files', () => {
    const rules = readFileSync(resolve(process.cwd(), '.vscodeignore'), 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'));

    expect(rules[0]).toBe('**');
    expect(rules.slice(1)).toEqual(REQUIRED_PACKAGE_FILES.map((file) => `!${file}`));
  });
});
