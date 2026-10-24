// @vitest-environment node
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import manifest from '../../package.json';
import { hasChangelogEntry, isPublicRepository } from '../../scripts/release/publish-decision.mjs';

// The publish decision has to tell these two names apart.
const PUBLIC_REPOSITORY = 'Ymmy833y/Agentic-HTML-Visual-Editor';
const DEVELOPMENT_REPOSITORY = 'Ymmy833y/Agentic-HTML-Visual-Editor-3';

// The 8-byte signature at the start of a PNG.
const PNG_SIGNATURE = '89504e470d0a1a0a';

// The smallest width and height the listing page accepts for the icon.
const MINIMUM_ICON_SIZE = 128;

/**
 * Reads a file by its path relative to the repository root.
 *
 * @param relativePath The path relative to the repository root.
 * @returns The contents of the file.
 */
function readRepositoryFile(relativePath: string): Buffer {
  return readFileSync(fileURLToPath(new URL(`../../${relativePath}`, import.meta.url)));
}

/**
 * Takes the paths of the images a README refers to by relative path, in order of appearance. Images over http(s),
 * the badges, are left out.
 *
 * @param relativePath The README's path relative to the repository root.
 * @returns The image paths.
 */
function readRelativeImages(relativePath: string): string[] {
  const readme = readRepositoryFile(relativePath).toString('utf8');
  return [...readme.matchAll(/<img\s[^>]*src="([^"]+)"|!\[[^\]]*\]\(([^)\s]+)/g)]
    .map((match) => match[1] ?? match[2] ?? '')
    .filter((source) => !/^https?:/.test(source));
}

/**
 * Takes the version shown by the version badge at the top of a README.
 *
 * @param relativePath The README's path relative to the repository root.
 * @returns The version the badge shows, or undefined when there is no badge.
 */
function readBadgeVersion(relativePath: string): string | undefined {
  const readme = readRepositoryFile(relativePath).toString('utf8');
  return /img\.shields\.io\/badge\/VS%20Marketplace-v(\d+\.\d+\.\d+)-/.exec(readme)?.[1];
}

describe('version and changelog', () => {
  it('has a CHANGELOG.md heading for the version in package.json', () => {
    const changelog = readRepositoryFile('CHANGELOG.md').toString('utf8');

    expect(hasChangelogEntry(changelog, manifest.version)).toBe(true);
  });

  it('has the version in package.json as the first version heading of CHANGELOG.md', () => {
    const changelog = readRepositoryFile('CHANGELOG.md').toString('utf8');

    expect(/^## \[([^\]]+)\]/m.exec(changelog)?.[1]).toBe(manifest.version);
  });

  it('shows the version in package.json on the version badges of README.md and README_ja.md', () => {
    // A badge left behind after a version bump would keep showing the old version on the listing page and on GitHub.
    expect({
      english: readBadgeVersion('README.md'),
      japanese: readBadgeVersion('README_ja.md'),
    }).toEqual({ english: manifest.version, japanese: manifest.version });
  });
});

describe('listing', () => {
  it('declares a repository that the publish decision matches to the public repository name and not to the development one', () => {
    expect({
      public: isPublicRepository(PUBLIC_REPOSITORY, manifest.repository.url),
      development: isPublicRepository(DEVELOPMENT_REPOSITORY, manifest.repository.url),
    }).toEqual({ public: true, development: false });
  });

  it('points icon at a PNG at least 128 pixels wide and high', () => {
    const icon = readRepositoryFile(manifest.icon);

    // The IHDR width and height sit at bytes 16 and 20, after the signature and the chunk header.
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

describe('README images', () => {
  it('refers only to existing PNG images by relative path, in the same order in README.md and README_ja.md', () => {
    const english = readRelativeImages('README.md');
    const japanese = readRelativeImages('README_ja.md');
    const distinct = [...new Set(english)];

    // The listing page refuses SVG, so the images have to be PNG.
    expect({
      found: english.length > 0,
      signatures: distinct.map((source) => readRepositoryFile(source).subarray(0, 8).toString('hex')),
      japanese,
    }).toEqual({ found: true, signatures: distinct.map(() => PNG_SIGNATURE), japanese: english });
  });
});

describe('README links', () => {
  it('points the HTML links of README.md only at headings in the page or at absolute URLs', () => {
    const readme = readRepositoryFile('README.md').toString('utf8');
    // vsce rewrites Markdown links and images to URLs in the public repository, but not an HTML <a href>.
    // Left relative in the package, such a link cannot open the repository file from the listing page.
    const relative = [...readme.matchAll(/<a\s[^>]*href="([^"]*)"/g)]
      .map((match) => match[1] ?? '')
      .filter((href) => !/^(?:https?:\/\/|#)/.test(href));

    expect(relative).toEqual([]);
  });
});

describe('vsce for publishing', () => {
  it('declares @vscode/vsce as one exact version, the same version package-lock.json installs', () => {
    const tools: { dependencies: Record<string, string> } = JSON.parse(
      readRepositoryFile('scripts/release/package.json').toString('utf8'),
    );
    const lock: { packages: Record<string, { version?: string }> } = JSON.parse(
      readRepositoryFile('scripts/release/package-lock.json').toString('utf8'),
    );
    const declared = tools.dependencies['@vscode/vsce'];

    // Declared as a range, the vsce that handles the credential could change version whenever the lockfile is regenerated.
    expect({
      exact: /^\d+\.\d+\.\d+$/.test(declared),
      locked: lock.packages['node_modules/@vscode/vsce']?.version,
    }).toEqual({ exact: true, locked: declared });
  });

  it('installs the @azure/identity stub in place of the real package, so no MSAL library is installed', () => {
    const lock: { packages: Record<string, { resolved?: string; link?: boolean }> } = JSON.parse(
      readRepositoryFile('scripts/release/package-lock.json').toString('utf8'),
    );

    expect({
      identity: lock.packages['node_modules/@azure/identity'],
      msal: Object.keys(lock.packages).filter((path) => path.includes('@azure/msal')),
    }).toEqual({ identity: { resolved: 'stubs/azure-identity', link: true }, msal: [] });
  });

  it('makes the @azure/identity stub fail with the reason when vsce builds a Microsoft Entra ID credential', () => {
    const stub: Record<string, new () => unknown> = createRequire(import.meta.url)(
      '../../scripts/release/stubs/azure-identity/index.js',
    );

    // The credentials vsce 4.0.0 builds for --azure-credential.
    const names = [
      'ChainedTokenCredential',
      'EnvironmentCredential',
      'AzureCliCredential',
      'ManagedIdentityCredential',
      'AzurePowerShellCredential',
      'AzureDeveloperCliCredential',
    ];
    for (const name of names) {
      const Credential = stub[name];
      expect(() => new Credential(), name).toThrow(/personal access token/);
    }
  });
});

/**
 * Splits a workflow into its jobs.
 *
 * @param workflow The workflow text.
 * @returns The text of each job under `jobs`, keyed by the job id.
 */
function readJobs(workflow: string): Record<string, string> {
  const body = workflow.slice(workflow.search(/^jobs:$/m));
  const jobs: Record<string, string> = {};
  for (const match of body.matchAll(/^ {2}([\w-]+):\n((?:(?: {4}.*)?\n)*)/gm)) {
    jobs[match[1] ?? ''] = match[2] ?? '';
  }
  return jobs;
}

describe('publish workflow', () => {
  // A Windows checkout may hold CRLF line endings, which the patterns below do not expect.
  const workflow = readRepositoryFile('.github/workflows/publish.yml').toString('utf8').replace(/\r\n/g, '\n');

  it('pins every action to a full commit SHA', () => {
    const actions = [...workflow.matchAll(/uses:\s*(\S+)/g)].map((match) => match[1] ?? '');

    // A tag can be moved to other code; a commit cannot.
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.filter((action) => !/@[0-9a-f]{40}$/.test(action))).toEqual([]);
  });

  it('gives the credential only to a job that neither installs the repository dependencies nor builds', () => {
    const jobs = readJobs(workflow);
    const holders = Object.entries(jobs).filter(([, job]) => job.includes('secrets.'));

    // Every npm ci in the job that holds the credential installs the release tools only.
    expect(holders.map(([id, job]) => ({
      id,
      installs: (job.match(/run: npm ci\b/g) ?? []).length,
      releaseToolInstalls: (job.match(/run: npm ci\b.*\n\s+working-directory: scripts\/release\n/g) ?? []).length,
      builds: /vsce package|npm run/.test(job),
    }))).toEqual([{ id: 'publish', installs: 1, releaseToolInstalls: 1, builds: false }]);
  });
});
