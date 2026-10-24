// Writes the third-party software that ships in the package, with its license texts, to THIRD_PARTY_NOTICES.md.
//
//   node scripts/release/third-party-notices.mjs           regenerates the notices
//   node scripts/release/third-party-notices.mjs --check   checks that the notices are current (exit code 1 if not)
//
// The bundle is built in memory with the production options, and the packages that reach its output are the starting
// points. A prebuilt package such as mermaid has already embedded its dependencies, which then never show up among the
// bundle's inputs; they are found through the source maps under each starting point and through declared
// dependencies. Declared dependencies include some that are never embedded, but listing too many beats missing one.

import * as esbuild from 'esbuild';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createBuildOptionsList } from '../../esbuild.mjs';

const REPOSITORY_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const NOTICES_PATH = join(REPOSITORY_ROOT, 'THIRD_PARTY_NOTICES.md');

// Where package.json files and license texts that fill gaps in installed packages are kept, one folder per name.
const SUPPLEMENT_DIR = fileURLToPath(new URL('./third-party-licenses/', import.meta.url));

const NODE_MODULES_SEGMENT = 'node_modules/';

// License text file names, including names with a qualifier such as LICENSE-MPL.
const LICENSE_FILE_PATTERN = /^(?:licen[cs]e|copying)(?:[-.][\w.-]*)?$/i;
// A script such as cytoscape's license-update.mjs matches the names above but is not a license text.
const SCRIPT_FILE_PATTERN = /\.(?:[cm]?js|ts|json)$/i;

// The opening of the notices, which ship in the package.
const NOTICES_HEADER = [
  '# Third-Party Notices',
  '',
  'Agentic HTML Visual Editor bundles the following third-party software, including the packages that its bundled',
  'dependencies embed. The list errs on the side of inclusion, so a few entries may not end up in the shipped code.',
].join('\n');

/**
 * @typedef {{ dirs: Set<string>, embeddedVersions: Set<string> }} FoundPackage
 *   Where a package was found installed, and the versions that source maps say were embedded.
 * @typedef {{ name: string, versions: string[], license: string, licenseText: string }} NoticeEntry
 *   One entry of the notices.
 */

/**
 * Takes the package name, and the version when the path shows it, out of a path.
 *
 * @param {string} sourcePath An input of the bundle, or an element of a source map's sources.
 * @returns {{ name: string, version: string | undefined } | null} The name and the version, or null outside
 *   node_modules.
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
  // .pnpm and .bin are places, not packages.
  if (name === '' || name.startsWith('.') || (isScoped && name.endsWith('/'))) {
    return null;
  }

  // The source maps of a package built with pnpm point at .pnpm/<name>@<version>/node_modules/<name>/, which gives the
  // version. The / of a scope becomes +, and the version may be followed by a peer dependency such as _cytoscape@3.34.0.
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
 * Takes the directories of the third-party packages that have bytes in the output out of esbuild metafiles.
 *
 * @param {Array<{ outputs: Record<string, { inputs: Record<string, { bytesInOutput: number }> }> }>} metafiles
 *   The esbuild metafiles.
 * @returns {string[]} The package directories relative to esbuild's working directory, sorted.
 */
export function collectBundledPackageDirs(metafiles) {
  const dirs = new Set();
  for (const metafile of metafiles) {
    for (const output of Object.values(metafile.outputs)) {
      for (const [inputPath, input] of Object.entries(output.inputs)) {
        // An input dropped by tree shaking does not ship.
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
 * Reads the package.json of a package directory.
 *
 * @param {string} dir The package directory.
 * @returns {Record<string, any>} The contents of package.json.
 */
function readManifest(dir) {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
}

/**
 * Finds the installed directory of a package the way Node.js resolves it: in the node_modules of the starting directory
 * first, then in those of each parent.
 *
 * @param {string} name The package name.
 * @param {string} fromDir The directory to start from.
 * @returns {string | undefined} The installed directory, or undefined when the package is not installed.
 */
function resolveInstalledDir(name, fromDir) {
  for (let current = fromDir; ; current = dirname(current)) {
    const candidate = join(current, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) {
      return candidate;
    }
    if (dirname(current) === current) {
      return undefined;
    }
  }
}

/**
 * Lists the source maps under a package directory. A nested node_modules holds packages of its own, which are visited
 * separately.
 *
 * @param {string} dir The package directory.
 * @returns {string[]} The paths of the source maps.
 */
function listSourceMaps(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((item) => {
    if (item.isDirectory()) {
      return item.name === 'node_modules' ? [] : listSourceMaps(join(dir, item.name));
    }
    return item.name.endsWith('.map') ? [join(dir, item.name)] : [];
  });
}

/**
 * Lists the license text files in a directory.
 *
 * @param {string} dir The directory, which may not exist.
 * @returns {string[]} The file names, sorted.
 */
function listLicenseFiles(dir) {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((name) => LICENSE_FILE_PATTERN.test(name) && !SCRIPT_FILE_PATTERN.test(name))
    .filter((name) => statSync(join(dir, name)).isFile())
    .sort();
}

/**
 * Reads the license type that a package.json declares, including the old licenses array.
 *
 * @param {Record<string, any>} manifest The contents of package.json.
 * @returns {string | undefined} The license type, or undefined when none is declared.
 */
function licenseOf(manifest) {
  if (typeof manifest.license === 'string') {
    return manifest.license;
  }
  if (Array.isArray(manifest.licenses)) {
    return manifest.licenses.map((item) => item.type).join(' OR ');
  }
  return undefined;
}

/**
 * Sorts versions in numeric order, so that 1.10.0 follows 1.9.0.
 *
 * @param {Iterable<string>} versions The versions.
 * @returns {string[]} The sorted versions.
 */
function sortVersions(versions) {
  return [...versions].sort((left, right) => left.localeCompare(right, 'en', { numeric: true }));
}

/**
 * Orders entries by name in code unit order, the same in every locale.
 *
 * @param {{ name: string }} left An entry.
 * @param {{ name: string }} right Another entry.
 * @returns {number} Negative, 0 or positive.
 */
function compareByName(left, right) {
  if (left.name < right.name) {
    return -1;
  }
  return left.name > right.name ? 1 : 0;
}

/**
 * Collects the versions of the packages that the bundle imports straight from node_modules. The installed version is
 * the one that ships. A copy of the same name in a nested node_modules is bundled too, so each name keeps every version.
 *
 * @param {string[]} rootDirs The directories of the starting packages.
 * @returns {Map<string, Set<string>>} The versions by package name.
 */
function collectBundledVersions(rootDirs) {
  /** @type {Map<string, Set<string>>} */
  const bundledVersions = new Map();
  for (const dir of rootDirs) {
    const { name, version } = readManifest(dir);
    if (typeof version === 'string') {
      bundledVersions.set(name, (bundledVersions.get(name) ?? new Set()).add(version));
    }
  }
  return bundledVersions;
}

/**
 * Follows the embedded and the declared dependencies from the starting packages and records every package reached.
 *
 * @param {string[]} rootDirs The directories of the starting packages.
 * @returns {Map<string, FoundPackage>} The packages reached, by name.
 */
function traversePackages(rootDirs) {
  /** @type {Map<string, FoundPackage>} */
  const found = new Map();
  /** @type {string[]} */
  const pending = [];
  const visited = new Set();

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

    // A package of type definitions only holds no code that runs, so it does not ship.
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      if (!name.startsWith('@types/')) {
        note(name, resolveInstalledDir(name, dir), undefined);
      }
    }
  }
  return found;
}

/**
 * Puts together the notice entry of one package.
 *
 * @param {string} name The package name.
 * @param {FoundPackage} entry Where the package was found and the embedded versions.
 * @param {Set<string> | undefined} bundledVersions The versions the bundle imports straight from node_modules.
 * @param {string} supplementDir The directory that fills gaps in installed packages.
 * @returns {NoticeEntry | undefined} The entry, or undefined when the license text, the license type or the version is
 *   missing.
 */
function describePackage(name, entry, bundledVersions, supplementDir) {
  // The supplement comes first: it exists because what was installed is incomplete.
  const candidates = [join(supplementDir, name), ...entry.dirs];
  const licenseDir = candidates.find((dir) => listLicenseFiles(dir).length > 0);
  // A supplement package.json may hold only the fields the installed one lacks. Without a version in the supplement,
  // the installed version stays.
  const manifests = candidates.filter((dir) => existsSync(join(dir, 'package.json'))).map(readManifest);
  const license = manifests.map(licenseOf).find((value) => value !== undefined);
  const installedVersion = manifests.map((manifest) => manifest.version).find((value) => typeof value === 'string');

  // The versions the bundle imports straight from node_modules come first. The source maps under a starting package
  // also name other versions, embedded in prebuilt files that never reach the bundle (such as Mermaid's
  // mermaid.esm.min), and listing those would show a stale version in place of the one the lockfile fixed. Without a
  // direct import, the embedded versions the source maps name are listed, and failing that the installed version.
  let versions;
  if (bundledVersions !== undefined) {
    versions = sortVersions(bundledVersions);
  } else if (entry.embeddedVersions.size > 0) {
    versions = sortVersions(entry.embeddedVersions);
  } else {
    versions = installedVersion === undefined ? [] : [installedVersion];
  }

  // An entry without a license type could be read as disagreeing with the license text it carries, so it stops the
  // run the same way a missing license text does.
  if (licenseDir === undefined || license === undefined || versions.length === 0) {
    return undefined;
  }
  const licenseText = listLicenseFiles(licenseDir)
    .map((file) => readFileSync(join(licenseDir, file), 'utf8').replaceAll('\r\n', '\n').trimEnd())
    .join('\n\n');
  return { name, versions, license, licenseText };
}

/**
 * Follows the embedded and the declared dependencies from the starting packages and collects their licenses.
 *
 * @param {string[]} rootDirs The directories of the starting packages.
 * @param {{ supplementDir: string }} options The directory that fills gaps in installed packages.
 * @returns {NoticeEntry[]} The entries, sorted by name.
 */
export function collectThirdPartyPackages(rootDirs, { supplementDir }) {
  const bundledVersions = collectBundledVersions(rootDirs);
  const missing = [];
  const packages = [];
  for (const [name, entry] of traversePackages(rootDirs)) {
    const described = describePackage(name, entry, bundledVersions.get(name), supplementDir);
    if (described === undefined) {
      missing.push(name);
    } else {
      packages.push(described);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `These packages lack a license text, a license type or a version: ${missing.sort().join(', ')}. `
        + 'Put the license text of the bundled version, or a package.json with the missing fields, in '
        + 'scripts/release/third-party-licenses/<name>/.',
    );
  }
  return packages.sort(compareByName);
}

/**
 * Renders the entries as Markdown, sorted by name.
 *
 * @param {NoticeEntry[]} packages The entries.
 * @returns {string} The text of THIRD_PARTY_NOTICES.md.
 */
export function renderThirdPartyNotices(packages) {
  const sections = [...packages]
    .sort(compareByName)
    .map(({ name, versions, license, licenseText }) =>
      [`## ${name} ${versions.join(', ')}`, '', `License: ${license}`, '', '```text', licenseText, '```'].join('\n'),
    );
  return `${[NOTICES_HEADER, ...sections].join('\n\n')}\n`;
}

/**
 * Builds the notices from the production bundle, then writes them or checks them against the current file.
 *
 * @param {string[]} args The command arguments.
 * @returns {Promise<number>} The exit code.
 */
async function main(args) {
  const check = args.includes('--check');
  // The production options count the same inputs as the package, and building in memory leaves dist/ alone.
  const isDevelopment = false;
  const results = await Promise.all(
    createBuildOptionsList(isDevelopment).map((options) =>
      esbuild.build({ ...options, absWorkingDir: REPOSITORY_ROOT, write: false, metafile: true, logLevel: 'warning' }),
    ),
  );
  const rootDirs = collectBundledPackageDirs(results.map((result) => result.metafile)).map((dir) =>
    join(REPOSITORY_ROOT, dir),
  );
  const packages = collectThirdPartyPackages(rootDirs, { supplementDir: SUPPLEMENT_DIR });
  const notices = renderThirdPartyNotices(packages);

  if (check) {
    // A Windows checkout may turn the line endings into CRLF; the same content still counts as a match.
    const current = existsSync(NOTICES_PATH) ? readFileSync(NOTICES_PATH, 'utf8').replaceAll('\r\n', '\n') : '';
    if (current !== notices) {
      console.error('THIRD_PARTY_NOTICES.md disagrees with the production bundle. Regenerate it with npm run notices.');
      return 1;
    }
    console.log(`THIRD_PARTY_NOTICES.md matches the production bundle (${packages.length} packages).`);
    return 0;
  }

  writeFileSync(NOTICES_PATH, notices);
  console.log(`Wrote ${packages.length} packages to THIRD_PARTY_NOTICES.md.`);
  return 0;
}

// Runs only when executed directly, not when a test imports the module. Node.js keeps its own URL as the real path with
// symbolic links resolved, so the path it was started with is resolved too; otherwise a start through a link would end
// without building anything.
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
