// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import manifest from '../../package.json';
import { hasChangelogEntry, isPublicRepository } from '../../scripts/release/publish-decision.mjs';

// 公開の判定は、この 2 つの名前を見分けられなければならない。
const PUBLIC_REPOSITORY = 'Ymmy833y/Agentic-HTML-Visual-Editor';
const DEVELOPMENT_REPOSITORY = 'Ymmy833y/Agentic-HTML-Visual-Editor-3';

// PNG の先頭 8 バイトの署名。
const PNG_SIGNATURE = '89504e470d0a1a0a';

// 掲載ページのアイコンに求められる最小の縦横。
const MINIMUM_ICON_SIZE = 128;

/**
 * リポジトリの直下からの相対パスでファイルを読む。
 *
 * @param relativePath リポジトリの直下からの相対パス。
 * @returns ファイルの内容。
 */
function readRepositoryFile(relativePath: string): Buffer {
  return readFileSync(fileURLToPath(new URL(`../../${relativePath}`, import.meta.url)));
}

/**
 * README が相対パスで参照する画像のパスを、出てくる順に取り出す。http(s) の画像（バッジ）は除く。
 *
 * @param relativePath README のリポジトリの直下からの相対パス。
 * @returns 画像のパスの並び。
 */
function readRelativeImages(relativePath: string): string[] {
  const readme = readRepositoryFile(relativePath).toString('utf8');
  return [...readme.matchAll(/<img\s[^>]*src="([^"]+)"|!\[[^\]]*\]\(([^)\s]+)/g)]
    .map((match) => match[1] ?? match[2] ?? '')
    .filter((source) => !/^https?:/.test(source));
}

/**
 * README の冒頭にある版のバッジが示す版を取り出す。
 *
 * @param relativePath README のリポジトリの直下からの相対パス。
 * @returns バッジが示す版。バッジが見つからなければ undefined。
 */
function readBadgeVersion(relativePath: string): string | undefined {
  const readme = readRepositoryFile(relativePath).toString('utf8');
  return /img\.shields\.io\/badge\/VS%20Marketplace-v(\d+\.\d+\.\d+)-/.exec(readme)?.[1];
}

describe('版と変更履歴', () => {
  it('CHANGELOG.md に package.json の版の見出しがある', () => {
    const changelog = readRepositoryFile('CHANGELOG.md').toString('utf8');

    expect(hasChangelogEntry(changelog, manifest.version)).toBe(true);
  });

  it('CHANGELOG.md の最初の版の見出しが package.json の版と一致する', () => {
    const changelog = readRepositoryFile('CHANGELOG.md').toString('utf8');

    expect(/^## \[([^\]]+)\]/m.exec(changelog)?.[1]).toBe(manifest.version);
  });

  it('README.md と README_ja.md の版のバッジが、package.json の版を示す', () => {
    // 版を上げたのにバッジを直し忘れると、掲載ページと GitHub が古い版を示し続ける。
    expect({
      english: readBadgeVersion('README.md'),
      japanese: readBadgeVersion('README_ja.md'),
    }).toEqual({ english: manifest.version, japanese: manifest.version });
  });
});

describe('掲載情報', () => {
  it('repository は、公開リポジトリの名前では公開リポジトリと判定され、開発リポジトリの名前では判定されない', () => {
    expect({
      public: isPublicRepository(PUBLIC_REPOSITORY, manifest.repository.url),
      development: isPublicRepository(DEVELOPMENT_REPOSITORY, manifest.repository.url),
    }).toEqual({ public: true, development: false });
  });

  it('icon が指すファイルが、縦横 128 以上の PNG である', () => {
    const icon = readRepositoryFile(manifest.icon);

    // IHDR の幅と高さは、署名とチャンクの見出しに続く 16 バイト目と 20 バイト目にある。
    expect({
      signature: icon.subarray(0, 8).toString('hex'),
      wide: icon.readUInt32BE(16) >= MINIMUM_ICON_SIZE,
      tall: icon.readUInt32BE(20) >= MINIMUM_ICON_SIZE,
    }).toEqual({ signature: PNG_SIGNATURE, wide: true, tall: true });
  });
});

describe('minimum VS Code version', () => {
  it('pins the VS Code type definitions to the engines floor, and both READMEs state that floor', () => {
    const floor = /^\^(\d+\.\d+)\.\d+$/.exec(manifest.engines.vscode)?.[1];
    const english = readRepositoryFile('README.md').toString('utf8');
    const japanese = readRepositoryFile('README_ja.md').toString('utf8');

    // Types newer than the floor would let an API the oldest supported VS Code lacks pass the type check.
    expect({
      types: manifest.devDependencies['@types/vscode'],
      englishBadge: /img\.shields\.io\/badge\/VS%20Code-(\d+\.\d+)%2B-/.exec(english)?.[1],
      englishText: /^- VS Code (\d+\.\d+) or later\.$/m.exec(english)?.[1],
      japaneseBadge: /img\.shields\.io\/badge\/VS%20Code-(\d+\.\d+)%2B-/.exec(japanese)?.[1],
      japaneseText: /^- VS Code (\d+\.\d+) 以降が必要です。$/m.exec(japanese)?.[1],
    }).toEqual({
      types: manifest.engines.vscode.slice(1),
      englishBadge: floor,
      englishText: floor,
      japaneseBadge: floor,
      japaneseText: floor,
    });
  });
});

describe('README の画像', () => {
  it('README.md と README_ja.md が相対パスで参照する画像がすべて実在する PNG で、2 つの README の画像の並びが一致する', () => {
    const english = readRelativeImages('README.md');
    const japanese = readRelativeImages('README_ja.md');
    const distinct = [...new Set(english)];

    // 掲載ページは SVG を拒むので、画像は PNG に限る。
    expect({
      found: english.length > 0,
      signatures: distinct.map((source) => readRepositoryFile(source).subarray(0, 8).toString('hex')),
      japanese,
    }).toEqual({ found: true, signatures: distinct.map(() => PNG_SIGNATURE), japanese: english });
  });
});

describe('README のリンク', () => {
  it('README.md の HTML のリンクは、ページ内の見出しか絶対 URL だけを指す', () => {
    const readme = readRepositoryFile('README.md').toString('utf8');
    // vsce は Markdown のリンクと画像を公開リポジトリの URL へ書き換えるが、HTML の <a href> は書き換えない。
    // 相対のまま配布物に入ると、掲載ページではリポジトリのファイルを開けない。
    const relative = [...readme.matchAll(/<a\s[^>]*href="([^"]*)"/g)]
      .map((match) => match[1] ?? '')
      .filter((href) => !/^(?:https?:\/\/|#)/.test(href));

    expect(relative).toEqual([]);
  });
});

describe('公開に使う vsce', () => {
  it('@vscode/vsce を範囲でなく 1 つの版で宣言し、package-lock.json に入る vsce の版と一致する', () => {
    const tools: { dependencies: Record<string, string> } = JSON.parse(
      readRepositoryFile('scripts/release/package.json').toString('utf8'),
    );
    const lock: { packages: Record<string, { version?: string }> } = JSON.parse(
      readRepositoryFile('scripts/release/package-lock.json').toString('utf8'),
    );
    const declared = tools.dependencies['@vscode/vsce'];

    // 範囲で宣言すると、ロックファイルを作り直すたびに資格情報を扱う vsce の版が動きうる。
    expect({
      exact: /^\d+\.\d+\.\d+$/.test(declared),
      locked: lock.packages['node_modules/@vscode/vsce']?.version,
    }).toEqual({ exact: true, locked: declared });
  });
});
