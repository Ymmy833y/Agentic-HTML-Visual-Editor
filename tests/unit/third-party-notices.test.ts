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
 * Writes a file into the temporary directory, creating the folders on the way.
 *
 * @param relativePath The path relative to the temporary directory.
 * @param content The contents of the file.
 */
function writeFixture(relativePath: string, content: string): void {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/**
 * Puts one starting package in place, along with packages that can and cannot be reached from it.
 * The starting package is prebuilt with its dependencies embedded, so the embedded package appears in its source map.
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

describe('package from a path', () => {
  it.each([
    {
      label: 'a scoped package',
      path: 'node_modules/@braintree/sanitize-url/dist/index.js',
      expected: { name: '@braintree/sanitize-url', version: undefined },
    },
    {
      label: 'a nested node_modules',
      path: 'node_modules/cytoscape-fcose/node_modules/cose-base/cose-base.js',
      expected: { name: 'cose-base', version: undefined },
    },
    {
      label: 'a .pnpm version',
      path: '../../../../../node_modules/.pnpm/@braintree+sanitize-url@7.1.2/node_modules/@braintree/sanitize-url/dist/index.js',
      expected: { name: '@braintree/sanitize-url', version: '7.1.2' },
    },
    {
      label: 'a .pnpm version with a peer dependency suffix',
      path: '../../node_modules/.pnpm/cytoscape-cose-bilkent@4.1.0_cytoscape@3.34.0/node_modules/cytoscape-cose-bilkent/index.js',
      expected: { name: 'cytoscape-cose-bilkent', version: '4.1.0' },
    },
  ])('takes the name and the version from the path of $label', ({ path, expected }) => {
    expect(packageFromSourcePath(path)).toEqual(expected);
  });

  it('returns null for a path outside node_modules', () => {
    expect(packageFromSourcePath('../../../src/diagrams/flowchart/flowDb.ts')).toBeNull();
  });
});

describe('bundled packages', () => {
  it('returns only packages, leaving out inputs with no bytes in the output and our own sources', () => {
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

describe('collecting third-party packages', () => {
  it('returns embedded packages at their embedded version and declared dependencies at their installed version, leaving out type definitions', () => {
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

  it('returns the installed version of a package the bundle imports directly, not one named in a source map', () => {
    writeBundledFixture();
    // The prebuilt files under bundled embed an older embedded, and the bundle also imports embedded itself.
    const packages = collectThirdPartyPackages([join(root, 'node_modules/bundled'), join(root, 'node_modules/embedded')], {
      supplementDir: join(root, 'supplement'),
    });

    expect(packages.find(({ name }) => name === 'embedded')?.versions).toEqual(['3.2.0']);
  });

  it('returns every version of a package the bundle imports from a nested node_modules as well', () => {
    writeBundledFixture();
    writeFixture('node_modules/nesting/package.json', JSON.stringify({ name: 'nesting', version: '1.0.0', license: 'MIT' }));
    writeFixture('node_modules/nesting/LICENSE', 'nesting license');
    writeFixture(
      'node_modules/nesting/node_modules/embedded/package.json',
      JSON.stringify({ name: 'embedded', version: '2.0.0', license: 'ISC' }),
    );
    writeFixture('node_modules/nesting/node_modules/embedded/LICENSE', 'embedded license');

    const packages = collectThirdPartyPackages(
      [
        join(root, 'node_modules/bundled'),
        join(root, 'node_modules/embedded'),
        join(root, 'node_modules/nesting/node_modules/embedded'),
      ],
      { supplementDir: join(root, 'supplement') },
    );

    expect(packages.find(({ name }) => name === 'embedded')?.versions).toEqual(['2.0.0', '3.2.0']);
  });

  it('leaves out a development dependency that cannot be reached from a starting package, even when it is in node_modules', () => {
    writeBundledFixture();

    const packages = collectThirdPartyPackages([join(root, 'node_modules/bundled')], {
      supplementDir: join(root, 'supplement'),
    });

    expect(packages.map(({ name }) => name)).not.toContain('dev-only');
  });

  it('returns the license text from the supplement directory for a package installed without one', () => {
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

  it('throws an error naming both packages when two packages have no license text anywhere', () => {
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

  it('takes the license type from a supplement package.json that holds only the type, and the version from the installed package', () => {
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

  it('throws an error naming a package that has a license text but declares no license type anywhere', () => {
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

describe('third-party notices text', () => {
  it('lists the versions, the license type and the license text of unordered entries in name order', () => {
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
