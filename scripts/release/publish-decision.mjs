// Marketplace へ公開するかを決める。公開のワークフローの最初のジョブから呼ばれる。
//
// ワークフローは開発リポジトリに置かれ、リポジトリの反映で公開リポジトリにも入る。公開してよいのは公開リポジトリ
// だけなので、実行中のリポジトリが package.json の repository と一致するかを最初に確かめる。
// 公開の要否は、直前のコミットとの差ではなく Marketplace の公開済みの版との比較で決める。やり直した実行や、
// 複数のコミットをまとめた push でも、同じ判定になるためである。

import { realpathSync } from 'node:fs';
import { appendFile, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// 公開ギャラリーの照会の入口。vsce が掲載の情報を読むのと同じ API である。
const GALLERY_QUERY_URL = 'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery';
const GALLERY_API_VERSION = '3.0-preview.1';

// 拡張名（publisher.name）で引き、版は最新の 1 件だけを返させる。
const FILTER_TYPE_EXTENSION_NAME = 7;
const FLAG_INCLUDE_VERSIONS = 0x1;
const FLAG_INCLUDE_LATEST_VERSION_ONLY = 0x200;

// 応答が返らないまま公開の実行を止め続けないための上限。
const QUERY_TIMEOUT_MS = 30_000;

// Marketplace が受け付ける版の形。接尾辞の付いた版（1.0.0-beta.1 など）は受け付けられない。
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

// GitHub のリポジトリの URL から owner と repo を取り出す。https・git+https・ssh の綴りを受け付ける。
const GITHUB_REPOSITORY_PATTERN = /^(?:git\+)?(?:https?:\/\/|ssh:\/\/git@|git@)github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i;

/**
 * 版を major・minor・patch の 3 つの数に分ける。
 *
 * @param {unknown} text 版の文字列。
 * @returns {[number, number, number] | null} 3 つの数。形が違えば null。
 */
export function parseVersion(text) {
  if (typeof text !== 'string') {
    return null;
  }
  const match = VERSION_PATTERN.exec(text);
  if (match === null) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * 2 つの版の新旧を比べる。
 *
 * @param {string} left 比べる版。
 * @param {string} right 比べられる版。
 * @returns {number} left が新しければ正、同じなら 0、古ければ負。
 */
export function compareVersions(left, right) {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  if (leftParts === null || rightParts === null) {
    throw new Error(`版を比べられない：${left} と ${right}`);
  }
  // 文字列のまま比べると 1.10.0 が 1.9.0 より古くなるため、部分ごとに数として比べる。
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] - rightParts[index];
    }
  }
  return 0;
}

/**
 * 変更履歴に、指定した版の見出しがあるかを調べる。
 *
 * @param {string} changelog CHANGELOG.md の本文。
 * @param {string} version 版。
 * @returns {boolean} 見出しがあれば true。
 */
export function hasChangelogEntry(changelog, version) {
  // 見出しは「## [x.y.z] - 日付」。閉じ括弧までを含めて比べ、1.0.0-beta や 1.0.01 の見出しを拾わない。
  const heading = `## [${version}]`;
  return changelog.split(/\r?\n/).some((line) => line === heading || line.startsWith(`${heading} `));
}

/**
 * 実行中のリポジトリが、package.json の repository が指すリポジトリかを判定する。
 *
 * @param {string | undefined} repository 実行中のリポジトリの owner/repo。
 * @param {string | undefined} repositoryUrl package.json の repository の URL。
 * @returns {boolean} 同じリポジトリなら true。
 */
export function isPublicRepository(repository, repositoryUrl) {
  if (!repository || !repositoryUrl) {
    return false;
  }
  const match = GITHUB_REPOSITORY_PATTERN.exec(repositoryUrl.trim());
  if (match === null) {
    return false;
  }
  // GitHub はリポジトリの名前の大文字と小文字を区別しない。
  return `${match[1]}/${match[2]}`.toLowerCase() === repository.toLowerCase();
}

/**
 * Marketplace から、拡張の公開済みの最新版を取得する。
 *
 * @param {string} extensionId publisher.name の形の拡張 ID。
 * @param {typeof fetch} [fetchImpl] 照会に使う fetch。
 * @returns {Promise<{ kind: 'found', version: string } | { kind: 'none' }>} 公開済みの版、または未公開。
 */
export async function fetchPublishedVersion(extensionId, fetchImpl = fetch) {
  const response = await fetchImpl(GALLERY_QUERY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: `application/json;api-version=${GALLERY_API_VERSION}`,
    },
    body: JSON.stringify({
      filters: [{ criteria: [{ filterType: FILTER_TYPE_EXTENSION_NAME, value: extensionId }] }],
      flags: FLAG_INCLUDE_VERSIONS | FLAG_INCLUDE_LATEST_VERSION_ONLY,
    }),
    signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Marketplace への照会が HTTP ${response.status} で失敗した`);
  }
  const body = await response.json();
  const extensions = body?.results?.[0]?.extensions;
  if (!Array.isArray(extensions)) {
    throw new Error('Marketplace の応答に拡張の一覧が無い');
  }
  if (extensions.length === 0) {
    return { kind: 'none' };
  }
  const version = extensions[0]?.versions?.[0]?.version;
  // 解釈できない値を公開済みの版として扱うと比較が誤った結論を出すため、応答の形の不一致として扱う。
  if (parseVersion(version) === null) {
    throw new Error(`Marketplace の応答の版を解釈できない：${String(version)}`);
  }
  return { kind: 'found', version };
}

/**
 * 版・公開済みの版・変更履歴から、公開するかを決める。条件は上から順に当て、最初に当たったものに従う。
 *
 * @param {{ version: string, published: { kind: 'found', version: string } | { kind: 'none' } | { kind: 'error', message: string }, changelog: string }} input
 *   package.json の版、公開済みの版の取得結果、CHANGELOG.md の本文。
 * @returns {{ outcome: 'publish' | 'skip' | 'fail', reason: string }} 判定と、その理由。
 */
export function decidePublish({ version, published, changelog }) {
  if (parseVersion(version) === null) {
    return { outcome: 'fail', reason: `版 ${String(version)} は major.minor.patch の形でなく、Marketplace が受け付けない。` };
  }
  if (published.kind === 'error') {
    return { outcome: 'fail', reason: `公開済みの版を取得できないため、判定せずに止める（${published.message}）。` };
  }
  if (published.kind === 'found') {
    const order = compareVersions(version, published.version);
    if (order === 0) {
      return { outcome: 'skip', reason: `版 ${version} は公開済みのため、公開しない。` };
    }
    if (order < 0) {
      return { outcome: 'skip', reason: `版 ${version} は公開済みの版 ${published.version} より古いため、公開しない。` };
    }
  }
  if (!hasChangelogEntry(changelog, version)) {
    return { outcome: 'fail', reason: `CHANGELOG.md に版 ${version} の見出しが無いため、公開しない。` };
  }
  const previous = published.kind === 'found' ? published.version : '未公開';
  return { outcome: 'publish', reason: `版 ${version} を公開する（公開済みの版：${previous}）。` };
}

/**
 * 実行中のリポジトリと、そのコミットの package.json・CHANGELOG.md から公開するかを決める。
 *
 * @param {{ repository: string | undefined, manifest: { name?: string, publisher?: string, version: string, repository?: string | { url?: string } }, changelog: string, fetchImpl?: typeof fetch }} input
 *   実行中のリポジトリの owner/repo、package.json の内容、CHANGELOG.md の本文、照会に使う fetch。
 * @returns {Promise<{ outcome: 'publish' | 'skip' | 'fail', reason: string }>} 判定と、その理由。
 */
export async function evaluatePublish({ repository, manifest, changelog, fetchImpl = fetch }) {
  const repositoryUrl = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url;
  // 開発リポジトリやフォークでは、Marketplace へ照会もせずに終える。
  if (!isPublicRepository(repository, repositoryUrl)) {
    return {
      outcome: 'skip',
      reason: `${repository ?? '（不明なリポジトリ）'} は公開リポジトリ（${repositoryUrl ?? '未宣言'}）でないため、公開しない。`,
    };
  }
  /** @type {{ kind: 'found', version: string } | { kind: 'none' } | { kind: 'error', message: string }} */
  let published;
  try {
    published = await fetchPublishedVersion(`${manifest.publisher}.${manifest.name}`, fetchImpl);
  } catch (error) {
    published = { kind: 'error', message: error instanceof Error ? error.message : String(error) };
  }
  return decidePublish({ version: manifest.version, published, changelog });
}

/**
 * package.json と CHANGELOG.md を読んで判定し、後続のジョブが読む出力へ写す。
 *
 * @returns {Promise<number>} 終了コード。判定が失敗なら 1。
 */
async function main() {
  const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  const changelog = await readFile(new URL('../../CHANGELOG.md', import.meta.url), 'utf8');
  const decision = await evaluatePublish({ repository: process.env.GITHUB_REPOSITORY, manifest, changelog });
  console.log(`判定：${decision.outcome}。${decision.reason}`);

  // 手元で流すときは GITHUB_OUTPUT が無いので、判定の表示だけで終える。
  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath) {
    await appendFile(outputPath, `publish=${decision.outcome === 'publish'}\nversion=${manifest.version}\n`);
  }

  if (decision.outcome === 'fail') {
    // 注釈として出すと、実行の概要に理由が表示される。
    console.log(`::error::${decision.reason}`);
    return 1;
  }
  return 0;
}

// テストから読み込まれたときは判定を走らせず、直接実行されたときだけ動く。Node.js は自身の URL をシンボリックリンクを
// 解いた実体のパスで持つので、起動したパスも実体に直して比べる。直さないと、リンク越しの起動で何もせずに終わる。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
