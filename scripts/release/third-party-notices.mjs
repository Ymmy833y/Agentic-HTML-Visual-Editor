// 配布物に入る第三者の成果物と、そのライセンス文を THIRD_PARTY_NOTICES.md に書き出す。
//
//   node scripts/release/third-party-notices.mjs           表示を作り直す
//   node scripts/release/third-party-notices.mjs --check   表示が最新かを確かめる（食い違えば終了コード 1）
//
// 本番の設定でバンドルをメモリ上に作り、出力に入ったパッケージを起点にする。mermaid のように依存を取り込み済みの
// 配布物は、取り込んだパッケージがバンドルの入力に現れない。そこで起点の配下のソースマップと、宣言された依存を
// たどって見つける。宣言された依存には実際には取り込まれていないものも混ざるが、漏らすよりは多めに載せる。

import * as esbuild from 'esbuild';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createBuildOptionsList } from '../../esbuild.mjs';

const REPOSITORY_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const NOTICES_PATH = join(REPOSITORY_ROOT, 'THIRD_PARTY_NOTICES.md');

// 導入物に欠けたライセンス文や項目を補う package.json とライセンス文を、名前ごとのフォルダーに置く場所。
const SUPPLEMENT_DIR = fileURLToPath(new URL('./third-party-licenses/', import.meta.url));

const NODE_MODULES_SEGMENT = 'node_modules/';

// ライセンス文のファイル名。LICENSE-MPL のように種類を添えた名前も拾う。
const LICENSE_FILE_PATTERN = /^(?:licen[cs]e|copying)(?:[-.][\w.-]*)?$/i;
// 上の名前に当たっても、cytoscape の license-update.mjs のようなスクリプトはライセンス文ではない。
const SCRIPT_FILE_PATTERN = /\.(?:[cm]?js|ts|json)$/i;

// 表示の冒頭。表示は配布物に入る英語の文書なので、実装の段階から英語で書く。
const NOTICES_HEADER = [
  '# Third-Party Notices',
  '',
  'Agentic HTML Visual Editor bundles the following third-party software, including the packages that its bundled',
  'dependencies embed. The list errs on the side of inclusion, so a few entries may not end up in the shipped code.',
].join('\n');

/**
 * パスから、パッケージの名前と、分かれば版を取り出す。
 *
 * @param {string} sourcePath バンドルの入力か、ソースマップの sources の要素。
 * @returns {{ name: string, version: string | undefined } | null} 名前と版。node_modules の外なら null。
 */
export function packageFromSourcePath(sourcePath) {
  const normalized = sourcePath.replaceAll('\\', '/');
  const index = normalized.lastIndexOf(NODE_MODULES_SEGMENT);
  if (index < 0) {
    return null;
  }
  const segments = normalized.slice(index + NODE_MODULES_SEGMENT.length).split('/');
  const isScoped = segments[0].startsWith('@');
  const name = isScoped ? `${segments[0]}/${segments[1] ?? ''}` : segments[0];
  // .pnpm や .bin は置き場所であってパッケージではない。
  if (name === '' || name.startsWith('.') || (isScoped && name.endsWith('/'))) {
    return null;
  }

  // pnpm で作られた配布物のソースマップは .pnpm/<名前>@<版>/node_modules/<名前>/ を指すので、そこから版が分かる。
  // スコープの / は + に置き換わり、版の後ろには相手先の依存（_cytoscape@3.34.0 など）が付くことがある。
  const store = normalized.slice(0, index).split('/').filter((segment) => segment !== '');
  let version;
  if (store.length >= 2 && store[store.length - 2] === '.pnpm') {
    const prefix = `${name.replace('/', '+')}@`;
    const entry = store[store.length - 1];
    if (entry.startsWith(prefix)) {
      version = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?/.exec(entry.slice(prefix.length))?.[0];
    }
  }
  return { name, version };
}

/**
 * メタファイルから、出力にバイトを持つ第三者のパッケージのディレクトリを取り出す。
 *
 * @param {Array<{ outputs: Record<string, { inputs: Record<string, { bytesInOutput: number }> }> }>} metafiles
 *   esbuild のメタファイル。
 * @returns {string[]} esbuild の作業ディレクトリから見たパッケージのディレクトリ。名前順。
 */
export function collectBundledPackageDirs(metafiles) {
  const dirs = new Set();
  for (const metafile of metafiles) {
    for (const output of Object.values(metafile.outputs)) {
      for (const [inputPath, input] of Object.entries(output.inputs)) {
        // ツリーシェイキングで落ちた入力は、配布物に入らない。
        if (input.bytesInOutput === 0) {
          continue;
        }
        const found = packageFromSourcePath(inputPath);
        if (found === null) {
          continue;
        }
        const normalized = inputPath.replaceAll('\\', '/');
        const index = normalized.lastIndexOf(NODE_MODULES_SEGMENT);
        dirs.add(`${normalized.slice(0, index + NODE_MODULES_SEGMENT.length)}${found.name}`);
      }
    }
  }
  return [...dirs].sort();
}

/**
 * 起点のパッケージから、取り込まれた依存と宣言された依存をたどり、ライセンスを集める。
 *
 * @param {string[]} rootDirs 起点のパッケージのディレクトリ。
 * @param {{ supplementDir: string }} options 導入物に欠けたライセンス文や項目を補うディレクトリ。
 * @returns {Array<{ name: string, versions: string[], license: string, licenseText: string }>} 名前順の一覧。
 */
export function collectThirdPartyPackages(rootDirs, { supplementDir }) {
  /** @type {Map<string, { dirs: Set<string>, embeddedVersions: Set<string> }>} */
  const found = new Map();
  /** @type {string[]} */
  const pending = [];
  const visited = new Set();

  const readManifest = (dir) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));

  // Node.js の解決と同じく、自分の node_modules から親へ向かって探す。
  const resolveInstalledDir = (name, fromDir) => {
    for (let current = fromDir; ; current = dirname(current)) {
      const candidate = join(current, 'node_modules', name);
      if (existsSync(join(candidate, 'package.json'))) {
        return candidate;
      }
      if (dirname(current) === current) {
        return undefined;
      }
    }
  };

  const note = (name, installedDir, embeddedVersion) => {
    const entry = found.get(name) ?? { dirs: new Set(), embeddedVersions: new Set() };
    found.set(name, entry);
    if (installedDir !== undefined) {
      entry.dirs.add(installedDir);
      pending.push(installedDir);
    }
    if (embeddedVersion !== undefined) {
      entry.embeddedVersions.add(embeddedVersion);
    }
  };

  // 配下のソースマップを集める。入れ子の node_modules は、それぞれのパッケージとして別にたどる。
  const listSourceMaps = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((item) => {
      if (item.isDirectory()) {
        return item.name === 'node_modules' ? [] : listSourceMaps(join(dir, item.name));
      }
      return item.name.endsWith('.map') ? [join(dir, item.name)] : [];
    });

  const listLicenseFiles = (dir) =>
    existsSync(dir)
      ? readdirSync(dir)
          .filter((name) => LICENSE_FILE_PATTERN.test(name) && !SCRIPT_FILE_PATTERN.test(name))
          .filter((name) => statSync(join(dir, name)).isFile())
          .sort()
      : [];

  for (const dir of rootDirs) {
    note(readManifest(dir).name, dir, undefined);
  }

  while (pending.length > 0) {
    const dir = pending.pop();
    if (dir === undefined || visited.has(dir)) {
      continue;
    }
    visited.add(dir);
    const manifest = readManifest(dir);

    for (const mapPath of listSourceMaps(dir)) {
      const sources = JSON.parse(readFileSync(mapPath, 'utf8')).sources ?? [];
      for (const source of sources) {
        const embedded = packageFromSourcePath(source);
        if (embedded !== null && embedded.name !== manifest.name) {
          note(embedded.name, resolveInstalledDir(embedded.name, dir), embedded.version);
        }
      }
    }

    // 型定義だけのパッケージは実行されるコードを持たず、配布物に入らない。
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      if (!name.startsWith('@types/')) {
        note(name, resolveInstalledDir(name, dir), undefined);
      }
    }
  }

  // package.json が宣言するライセンスの種類。古い形式の licenses の配列も読み、宣言が無ければ undefined を返す。
  const licenseOf = (manifest) =>
    typeof manifest.license === 'string'
      ? manifest.license
      : Array.isArray(manifest.licenses)
        ? manifest.licenses.map((item) => item.type).join(' OR ')
        : undefined;

  const missing = [];
  const packages = [];
  for (const [name, entry] of found) {
    // 補足を先に見る。導入物にあっても不完全だから補足を置いているためである。
    const candidates = [join(supplementDir, name), ...entry.dirs];
    const licenseDir = candidates.find((dir) => listLicenseFiles(dir).length > 0);
    // 補足の package.json は、導入物に欠けた項目だけを持つことがある。版を書かない補足なら、導入された版が載り続ける。
    const manifests = candidates.filter((dir) => existsSync(join(dir, 'package.json'))).map(readManifest);
    const license = manifests.map(licenseOf).find((value) => value !== undefined);
    const version = manifests.map((manifest) => manifest.version).find((value) => typeof value === 'string');
    // 取り込まれた版が分かればそれを載せ、分からなければ導入された版を載せる。
    const versions =
      entry.embeddedVersions.size > 0
        ? [...entry.embeddedVersions].sort((left, right) => left.localeCompare(right, 'en', { numeric: true }))
        : version === undefined
          ? []
          : [version];
    // 種類の無い表示は、載せたライセンス文と食い違って読まれうる。ライセンス文が無いときと同じく止めて補足を求める。
    if (licenseDir === undefined || license === undefined || versions.length === 0) {
      missing.push(name);
      continue;
    }
    const licenseText = listLicenseFiles(licenseDir)
      .map((file) => readFileSync(join(licenseDir, file), 'utf8').replaceAll('\r\n', '\n').trimEnd())
      .join('\n\n');
    packages.push({ name, versions, license, licenseText });
  }

  if (missing.length > 0) {
    throw new Error(
      `ライセンス文・ライセンスの種類・版のどれかが見つからないパッケージがある：${missing.sort().join(', ')}。` +
        'scripts/release/third-party-licenses/<名前>/ に、取り込まれた版のライセンス文か、欠けた項目を持つ package.json を置く。',
    );
  }
  return packages.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

/**
 * 集めた結果を、名前順の Markdown にする。
 *
 * @param {Array<{ name: string, versions: string[], license: string, licenseText: string }>} packages 表示の項目。
 * @returns {string} THIRD_PARTY_NOTICES.md の本文。
 */
export function renderThirdPartyNotices(packages) {
  const sections = [...packages]
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    .map(({ name, versions, license, licenseText }) =>
      [`## ${name} ${versions.join(', ')}`, '', `License: ${license}`, '', '```text', licenseText, '```'].join('\n'),
    );
  return `${[NOTICES_HEADER, ...sections].join('\n\n')}\n`;
}

/**
 * 本番のバンドルから表示を作り、書き出すか、既存の表示と照合する。
 *
 * @param {string[]} args コマンドの引数。
 * @returns {Promise<number>} 終了コード。
 */
async function main(args) {
  const check = args.includes('--check');
  // 配布物と同じ入力を数えるため本番の設定を使い、dist/ を書き換えないようメモリ上でビルドする。
  const results = await Promise.all(
    createBuildOptionsList(false).map((options) =>
      esbuild.build({ ...options, absWorkingDir: REPOSITORY_ROOT, write: false, metafile: true, logLevel: 'warning' }),
    ),
  );
  const rootDirs = collectBundledPackageDirs(results.map((result) => result.metafile)).map((dir) =>
    join(REPOSITORY_ROOT, dir),
  );
  const packages = collectThirdPartyPackages(rootDirs, { supplementDir: SUPPLEMENT_DIR });
  const notices = renderThirdPartyNotices(packages);

  if (check) {
    // Windows で改行が CRLF に変わって取り出されても、内容が同じなら一致とする。
    const current = existsSync(NOTICES_PATH) ? readFileSync(NOTICES_PATH, 'utf8').replaceAll('\r\n', '\n') : '';
    if (current !== notices) {
      console.error('THIRD_PARTY_NOTICES.md が本番のバンドルと食い違っている。npm run notices で作り直す。');
      return 1;
    }
    console.log(`THIRD_PARTY_NOTICES.md は本番のバンドルと一致している（${packages.length} 件）。`);
    return 0;
  }

  writeFileSync(NOTICES_PATH, notices);
  console.log(`THIRD_PARTY_NOTICES.md に ${packages.length} 件のパッケージを書いた。`);
  return 0;
}

// テストから読み込まれたときはビルドを走らせず、直接実行されたときだけ動く。Node.js は自身の URL をシンボリックリンクを
// 解いた実体のパスで持つので、起動したパスも実体に直して比べる。直さないと、リンク越しの起動で何もせずに終わる。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    },
  );
}
