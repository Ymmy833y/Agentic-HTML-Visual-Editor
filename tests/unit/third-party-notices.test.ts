// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  collectBundledPackageDirs,
  collectThirdPartyPackages,
  packageFromSourcePath,
  renderThirdPartyNotices,
} from '../../scripts/release/third-party-notices.mjs';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'third-party-notices-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * 一時ディレクトリの中へ、途中のフォルダーごとファイルを書く。
 *
 * @param relativePath 一時ディレクトリから見たパス。
 * @param content ファイルの内容。
 */
function writeFixture(relativePath: string, content: string): void {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/**
 * 起点のパッケージを 1 つと、そこから届くパッケージ・届かないパッケージを置く。
 * 起点は依存を取り込み済みの配布物で、ソースマップに取り込んだパッケージが現れる。
 */
function writeBundledFixture(): void {
  writeFixture(
    'node_modules/bundled/package.json',
    JSON.stringify({
      name: 'bundled',
      version: '1.0.0',
      license: 'MIT',
      dependencies: { declared: '^2.0.0', '@types/typed': '^1.0.0' },
    }),
  );
  writeFixture('node_modules/bundled/LICENSE', 'bundled license');
  writeFixture(
    'node_modules/bundled/dist/index.js.map',
    JSON.stringify({
      version: 3,
      sources: ['../../../../node_modules/.pnpm/embedded@3.1.0/node_modules/embedded/index.js', '../src/own.ts'],
    }),
  );
  writeFixture('node_modules/embedded/package.json', JSON.stringify({ name: 'embedded', version: '3.2.0', license: 'ISC' }));
  writeFixture('node_modules/embedded/LICENSE', 'embedded license');
  writeFixture(
    'node_modules/declared/package.json',
    JSON.stringify({ name: 'declared', version: '2.0.1', license: 'BSD-3-Clause' }),
  );
  writeFixture('node_modules/declared/LICENSE', 'declared license');
  writeFixture('node_modules/@types/typed/package.json', JSON.stringify({ name: '@types/typed', version: '1.0.0' }));
  writeFixture('node_modules/@types/typed/LICENSE', 'typed license');
  writeFixture('node_modules/dev-only/package.json', JSON.stringify({ name: 'dev-only', version: '9.0.0', license: 'MIT' }));
  writeFixture('node_modules/dev-only/LICENSE', 'dev-only license');
}

describe('パスからのパッケージの特定', () => {
  it.each([
    {
      label: 'スコープ付きのパッケージ',
      path: 'node_modules/@braintree/sanitize-url/dist/index.js',
      expected: { name: '@braintree/sanitize-url', version: undefined },
    },
    {
      label: '入れ子の node_modules',
      path: 'node_modules/cytoscape-fcose/node_modules/cose-base/cose-base.js',
      expected: { name: 'cose-base', version: undefined },
    },
    {
      label: '.pnpm の版',
      path: '../../../../../node_modules/.pnpm/@braintree+sanitize-url@7.1.2/node_modules/@braintree/sanitize-url/dist/index.js',
      expected: { name: '@braintree/sanitize-url', version: '7.1.2' },
    },
    {
      label: '相手先の接尾辞が付いた .pnpm の版',
      path: '../../node_modules/.pnpm/cytoscape-cose-bilkent@4.1.0_cytoscape@3.34.0/node_modules/cytoscape-cose-bilkent/index.js',
      expected: { name: 'cytoscape-cose-bilkent', version: '4.1.0' },
    },
  ])('$label のパスから名前と版を取る', ({ path, expected }) => {
    expect(packageFromSourcePath(path)).toEqual(expected);
  });

  it('node_modules の外のパスには null を返す', () => {
    expect(packageFromSourcePath('../../../src/diagrams/flowchart/flowDb.ts')).toBeNull();
  });
});

describe('バンドルに入ったパッケージ', () => {
  it('出力のバイトが 0 の入力と自前のソースを除いたパッケージだけを返す', () => {
    const metafile = {
      outputs: {
        'dist/webview.js': {
          inputs: {
            'node_modules/mermaid/dist/mermaid.esm.min.mjs': { bytesInOutput: 120 },
            'node_modules/tree-shaken/index.js': { bytesInOutput: 0 },
            'webview/main.ts': { bytesInOutput: 40 },
            'node_modules/outer/node_modules/@scope/inner/index.js': { bytesInOutput: 10 },
          },
        },
      },
    };

    expect(collectBundledPackageDirs([metafile])).toEqual([
      'node_modules/mermaid',
      'node_modules/outer/node_modules/@scope/inner',
    ]);
  });
});

describe('第三者のパッケージの収集', () => {
  it('取り込まれたパッケージをその版で、宣言された依存を導入された版で返し、型定義は返さない', () => {
    writeBundledFixture();

    const packages = collectThirdPartyPackages([join(root, 'node_modules/bundled')], {
      supplementDir: join(root, 'supplement'),
    });

    expect(packages.map(({ name, versions }) => ({ name, versions }))).toEqual([
      { name: 'bundled', versions: ['1.0.0'] },
      { name: 'declared', versions: ['2.0.1'] },
      { name: 'embedded', versions: ['3.1.0'] },
    ]);
  });

  it('起点からたどれない開発依存は、node_modules にあっても返さない', () => {
    writeBundledFixture();

    const packages = collectThirdPartyPackages([join(root, 'node_modules/bundled')], {
      supplementDir: join(root, 'supplement'),
    });

    expect(packages.map(({ name }) => name)).not.toContain('dev-only');
  });

  it('導入物にライセンス文が無いパッケージは、補足のディレクトリのライセンス文で返す', () => {
    writeFixture(
      'node_modules/bundled/package.json',
      JSON.stringify({ name: 'bundled', version: '1.0.0', license: 'MIT', dependencies: { unlicensed: '^1.0.0' } }),
    );
    writeFixture('node_modules/bundled/LICENSE', 'bundled license');
    writeFixture('node_modules/unlicensed/package.json', JSON.stringify({ name: 'unlicensed', version: '1.0.0' }));
    writeFixture('supplement/unlicensed/package.json', JSON.stringify({ name: 'unlicensed', version: '1.0.0', license: 'MIT' }));
    writeFixture('supplement/unlicensed/LICENSE', 'license from the supplement');

    const packages = collectThirdPartyPackages([join(root, 'node_modules/bundled')], {
      supplementDir: join(root, 'supplement'),
    });

    expect(packages.find(({ name }) => name === 'unlicensed')?.licenseText).toBe('license from the supplement');
  });

  it('ライセンス文がどこにも無いパッケージが 2 つあると、2 つの名前を含む例外を投げる', () => {
    writeFixture(
      'node_modules/bundled/package.json',
      JSON.stringify({
        name: 'bundled',
        version: '1.0.0',
        license: 'MIT',
        dependencies: { 'missing-one': '^1.0.0', 'missing-two': '^1.0.0' },
      }),
    );
    writeFixture('node_modules/bundled/LICENSE', 'bundled license');
    writeFixture('node_modules/missing-one/package.json', JSON.stringify({ name: 'missing-one', version: '1.0.0' }));
    writeFixture('node_modules/missing-two/package.json', JSON.stringify({ name: 'missing-two', version: '1.0.0' }));

    expect(() =>
      collectThirdPartyPackages([join(root, 'node_modules/bundled')], { supplementDir: join(root, 'supplement') }),
    ).toThrow(/missing-one, missing-two/);
  });

  it('補足の package.json が種類だけを持つと、種類は補足から、版は導入物から取る', () => {
    writeFixture(
      'node_modules/bundled/package.json',
      JSON.stringify({ name: 'bundled', version: '1.0.0', license: 'MIT', dependencies: { typeless: '^2.0.0' } }),
    );
    writeFixture('node_modules/bundled/LICENSE', 'bundled license');
    writeFixture('node_modules/typeless/package.json', JSON.stringify({ name: 'typeless', version: '2.1.0' }));
    writeFixture('node_modules/typeless/LICENSE', 'typeless license');
    writeFixture('supplement/typeless/package.json', JSON.stringify({ name: 'typeless', license: 'MIT' }));

    const packages = collectThirdPartyPackages([join(root, 'node_modules/bundled')], {
      supplementDir: join(root, 'supplement'),
    });

    expect(packages.find(({ name }) => name === 'typeless')).toEqual({
      name: 'typeless',
      versions: ['2.1.0'],
      license: 'MIT',
      licenseText: 'typeless license',
    });
  });

  it('ライセンス文はあっても種類がどこにも宣言されていないパッケージがあると、その名前を含む例外を投げる', () => {
    writeFixture(
      'node_modules/bundled/package.json',
      JSON.stringify({ name: 'bundled', version: '1.0.0', license: 'MIT', dependencies: { typeless: '^2.0.0' } }),
    );
    writeFixture('node_modules/bundled/LICENSE', 'bundled license');
    writeFixture('node_modules/typeless/package.json', JSON.stringify({ name: 'typeless', version: '2.1.0' }));
    writeFixture('node_modules/typeless/LICENSE', 'typeless license');

    expect(() =>
      collectThirdPartyPackages([join(root, 'node_modules/bundled')], { supplementDir: join(root, 'supplement') }),
    ).toThrow(/typeless/);
  });
});

describe('第三者ライセンス表示の本文', () => {
  it('順不同の項目から、名前順に版・ライセンスの種類・ライセンス文を並べる', () => {
    const alpha = { name: 'alpha', versions: ['1.0.0', '1.1.0'], license: 'MIT', licenseText: 'alpha license' };
    const beta = { name: 'beta', versions: ['2.0.0'], license: 'ISC', licenseText: 'beta license' };

    const notices = renderThirdPartyNotices([beta, alpha]);

    expect(notices.slice(notices.indexOf('## '))).toBe(
      [
        '## alpha 1.0.0, 1.1.0',
        '',
        'License: MIT',
        '',
        '```text',
        'alpha license',
        '```',
        '',
        '## beta 2.0.0',
        '',
        'License: ISC',
        '',
        '```text',
        'beta license',
        '```',
        '',
      ].join('\n'),
    );
  });
});
