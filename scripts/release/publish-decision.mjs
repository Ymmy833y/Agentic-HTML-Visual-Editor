// Decides whether to publish to the Marketplace. The first job of the publish workflow runs it.
//
// The workflow lives in the development repository and reaches the public repository when the two are mirrored. Only
// the public repository may publish, so the first check is whether the running repository is the one package.json
// names in repository.
// Whether to publish is decided against the version already on the Marketplace, not against the previous commit, so a
// rerun or a push that carries several commits reaches the same decision.

import { realpathSync } from 'node:fs';
import { appendFile, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// The public gallery query endpoint, the same API vsce reads listings from.
const GALLERY_QUERY_URL = 'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery';
const GALLERY_API_VERSION = '3.0-preview.1';

// Look the extension up by publisher.name and return only its latest version.
const FILTER_TYPE_EXTENSION_NAME = 7;
const FLAG_INCLUDE_VERSIONS = 0x1;
const FLAG_INCLUDE_LATEST_VERSION_ONLY = 0x200;

// Keeps an unanswered query from holding up the publish run.
const QUERY_TIMEOUT_MS = 30_000;

// The version form the Marketplace accepts. A version with a suffix, such as 1.0.0-beta.1, is refused.
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

// Takes the owner and the repo out of a GitHub repository URL, spelled as https, git+https or ssh.
const GITHUB_REPOSITORY_PATTERN = /^(?:git\+)?(?:https?:\/\/|ssh:\/\/git@|git@)github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i;

/**
 * Splits a version into its major, minor and patch numbers.
 *
 * @param {unknown} text The version.
 * @returns {[number, number, number] | null} The three numbers, or null when the version has another form.
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
 * Compares two versions.
 *
 * @param {string} left The version compared.
 * @param {string} right The version compared against.
 * @returns {number} Positive when left is newer, 0 when they are equal, negative when left is older.
 */
export function compareVersions(left, right) {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  if (leftParts === null || rightParts === null) {
    throw new Error(`Cannot compare the versions ${left} and ${right}`);
  }
  // Compared as numbers part by part; compared as strings, 1.10.0 would be older than 1.9.0.
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] - rightParts[index];
    }
  }
  return 0;
}

/**
 * Tells whether the changelog has a heading for a version.
 *
 * @param {string} changelog The text of CHANGELOG.md.
 * @param {string} version The version.
 * @returns {boolean} True when the heading is there.
 */
export function hasChangelogEntry(changelog, version) {
  // The heading is "## [x.y.z] - date". Comparing up to the closing bracket keeps 1.0.0-beta and 1.0.01 from matching.
  const heading = `## [${version}]`;
  return changelog.split(/\r?\n/).some((line) => line === heading || line.startsWith(`${heading} `));
}

/**
 * Tells whether the running repository is the one that package.json names in repository.
 *
 * @param {string | undefined} repository The owner/repo of the running repository.
 * @param {string | undefined} repositoryUrl The repository URL from package.json.
 * @returns {boolean} True when both name the same repository.
 */
export function isPublicRepository(repository, repositoryUrl) {
  if (!repository || !repositoryUrl) {
    return false;
  }
  const match = GITHUB_REPOSITORY_PATTERN.exec(repositoryUrl.trim());
  if (match === null) {
    return false;
  }
  // GitHub does not distinguish the letter case of repository names.
  return `${match[1]}/${match[2]}`.toLowerCase() === repository.toLowerCase();
}

/**
 * Fetches the latest version of the extension published on the Marketplace.
 *
 * @param {string} extensionId The extension ID in the form publisher.name.
 * @param {typeof fetch} [fetchImpl] The fetch used for the query.
 * @returns {Promise<{ kind: 'found', version: string } | { kind: 'none' }>} The published version, or none when the
 *   extension has never been published.
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
    throw new Error(`The Marketplace query failed with HTTP ${response.status}`);
  }

  const body = await response.json();
  const extensions = body?.results?.[0]?.extensions;
  if (!Array.isArray(extensions)) {
    throw new Error('The Marketplace response has no list of extensions');
  }
  if (extensions.length === 0) {
    return { kind: 'none' };
  }

  const version = extensions[0]?.versions?.[0]?.version;
  // A value that cannot be read as a version would make the comparison draw a wrong conclusion, so it counts as a
  // response of the wrong shape.
  if (parseVersion(version) === null) {
    throw new Error(`Cannot read the version in the Marketplace response: ${String(version)}`);
  }
  return { kind: 'found', version };
}

/**
 * Decides from the version, the published version and the changelog whether to publish. The conditions are tried from
 * the top, and the first one that holds decides.
 *
 * @param {{ version: string, published: { kind: 'found', version: string } | { kind: 'none' } | { kind: 'error', message: string }, changelog: string }} input
 *   The version in package.json, the result of fetching the published version, and the text of CHANGELOG.md.
 * @returns {{ outcome: 'publish' | 'skip' | 'fail', reason: string }} The decision and its reason.
 */
export function decidePublish({ version, published, changelog }) {
  if (parseVersion(version) === null) {
    return {
      outcome: 'fail',
      reason: `Version ${String(version)} is not in the form major.minor.patch, which the Marketplace requires.`,
    };
  }
  if (published.kind === 'error') {
    return {
      outcome: 'fail',
      reason: `Stopping without a decision because the published version could not be fetched (${published.message}).`,
    };
  }
  if (published.kind === 'found') {
    const order = compareVersions(version, published.version);
    if (order === 0) {
      return { outcome: 'skip', reason: `Not publishing: version ${version} is already published.` };
    }
    if (order < 0) {
      return {
        outcome: 'skip',
        reason: `Not publishing: version ${version} is older than the published version ${published.version}.`,
      };
    }
  }
  if (!hasChangelogEntry(changelog, version)) {
    return { outcome: 'fail', reason: `Not publishing: CHANGELOG.md has no heading for version ${version}.` };
  }

  const previous = published.kind === 'found' ? published.version : 'none';
  return { outcome: 'publish', reason: `Publishing version ${version} (published version: ${previous}).` };
}

/**
 * Reads the repository URL from package.json, which may give it as a string or as an object with a url.
 *
 * @param {{ repository?: string | { url?: string } }} manifest The contents of package.json.
 * @returns {string | undefined} The repository URL, or undefined when none is declared.
 */
function readRepositoryUrl(manifest) {
  return typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url;
}

/**
 * Decides whether to publish from the running repository and from package.json and CHANGELOG.md of its commit.
 *
 * @param {{ repository: string | undefined, manifest: { name?: string, publisher?: string, version: string, repository?: string | { url?: string } }, changelog: string, fetchImpl?: typeof fetch }} input
 *   The owner/repo of the running repository, the contents of package.json, the text of CHANGELOG.md, and the fetch
 *   used for the query.
 * @returns {Promise<{ outcome: 'publish' | 'skip' | 'fail', reason: string }>} The decision and its reason.
 */
export async function evaluatePublish({ repository, manifest, changelog, fetchImpl = fetch }) {
  const repositoryUrl = readRepositoryUrl(manifest);
  // The development repository and forks stop here, without even querying the Marketplace.
  if (!isPublicRepository(repository, repositoryUrl)) {
    return {
      outcome: 'skip',
      reason: `Not publishing: ${repository ?? '(unknown repository)'} is not the public repository `
        + `(${repositoryUrl ?? 'not declared'}).`,
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
 * Reads package.json and CHANGELOG.md, decides, and writes the decision to the outputs the later jobs read.
 *
 * @returns {Promise<number>} The exit code: 1 when the decision is a failure.
 */
async function main() {
  const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  const changelog = await readFile(new URL('../../CHANGELOG.md', import.meta.url), 'utf8');
  const decision = await evaluatePublish({ repository: process.env.GITHUB_REPOSITORY, manifest, changelog });
  console.log(`Decision: ${decision.outcome}. ${decision.reason}`);

  // A local run has no GITHUB_OUTPUT, so it only prints the decision.
  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath) {
    await appendFile(outputPath, `publish=${decision.outcome === 'publish'}\nversion=${manifest.version}\n`);
  }

  if (decision.outcome === 'fail') {
    // As an annotation, the reason appears in the run summary.
    console.log(`::error::${decision.reason}`);
    return 1;
  }
  return 0;
}

// Runs only when executed directly, not when a test imports the module. Node.js keeps its own URL as the real path with
// symbolic links resolved, so the path it was started with is resolved too; otherwise a start through a link would end
// without doing anything.
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
