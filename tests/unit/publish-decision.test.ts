// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import {
  compareVersions,
  decidePublish,
  evaluatePublish,
  fetchPublishedVersion,
  hasChangelogEntry,
  isPublicRepository,
} from '../../scripts/release/publish-decision.mjs';

const PUBLIC_REPOSITORY = 'Ymmy833y/Agentic-HTML-Visual-Editor';
const DEVELOPMENT_REPOSITORY = 'Ymmy833y/Agentic-HTML-Visual-Editor-3';

// A package.json that names the public repository.
const MANIFEST = {
  name: 'agentic-html-visual-editor',
  publisher: 'YuyaMiyamoto',
  version: '1.0.0',
  repository: { type: 'git', url: 'https://github.com/Ymmy833y/Agentic-HTML-Visual-Editor.git' },
};

const CHANGELOG_WITH_ENTRY = [
  '# Changelog',
  '',
  '## [1.0.0] - 2026-10-01',
  '',
  '### Added',
  '',
  '- Rebuilt the editor.',
  '',
  '## [0.1.12] - 2026-09-23',
].join('\n');

const CHANGELOG_WITHOUT_ENTRY = ['# Changelog', '', '## [0.1.12] - 2026-09-23'].join('\n');

/**
 * Makes a fetch that returns a fixed response.
 *
 * @param body The value sent as the JSON body of the response.
 * @param status The HTTP status code.
 * @returns The fetch to use instead.
 */
function respondWith(body: unknown, status = 200): typeof fetch {
  return async () => new Response(JSON.stringify(body), { status });
}

describe('publish decision', () => {
  it('publishes a version newer than the published one when the changelog has its entry', () => {
    const decision = decidePublish({
      version: '1.0.0',
      published: { kind: 'found', version: '0.1.12' },
      changelog: CHANGELOG_WITH_ENTRY,
    });

    expect(decision.outcome).toBe('publish');
  });

  it('skips a version that is already published', () => {
    const decision = decidePublish({
      version: '1.0.0',
      published: { kind: 'found', version: '1.0.0' },
      changelog: CHANGELOG_WITH_ENTRY,
    });

    expect(decision.outcome).toBe('skip');
  });

  it('skips a version older than the published one and names both versions in the reason', () => {
    const decision = decidePublish({
      version: '1.0.0',
      published: { kind: 'found', version: '1.2.0' },
      changelog: CHANGELOG_WITH_ENTRY,
    });

    expect(decision).toEqual({
      outcome: 'skip',
      reason: expect.stringMatching(/1\.0\.0.*1\.2\.0/),
    });
  });

  it('publishes when nothing is published yet and the changelog has the entry', () => {
    const decision = decidePublish({
      version: '1.0.0',
      published: { kind: 'none' },
      changelog: CHANGELOG_WITH_ENTRY,
    });

    expect(decision.outcome).toBe('publish');
  });

  it('fails when the changelog has no entry, even for a version newer than the published one', () => {
    const decision = decidePublish({
      version: '1.0.0',
      published: { kind: 'found', version: '0.1.12' },
      changelog: CHANGELOG_WITHOUT_ENTRY,
    });

    expect(decision.outcome).toBe('fail');
  });

  it.each([
    { label: 'a version is published', published: { kind: 'found', version: '0.1.12' } as const },
    { label: 'nothing is published', published: { kind: 'none' } as const },
    { label: 'the fetch failed', published: { kind: 'error', message: 'network failure' } as const },
  ])('fails for a version with a suffix when $label', ({ published }) => {
    const decision = decidePublish({
      version: '1.0.0-beta.1',
      published,
      changelog: '## [1.0.0-beta.1] - 2026-10-01',
    });

    expect(decision.outcome).toBe('fail');
  });

  it('fails without publishing when the published version could not be fetched', () => {
    const decision = decidePublish({
      version: '1.0.0',
      published: { kind: 'error', message: 'network failure' },
      changelog: CHANGELOG_WITH_ENTRY,
    });

    expect(decision.outcome).toBe('fail');
  });
});

describe('publish decision including the running repository', () => {
  it('skips in the development repository without querying the Marketplace', async () => {
    const fetchImpl = vi.fn(respondWith({ results: [{ extensions: [] }] }));

    const decision = await evaluatePublish({
      repository: DEVELOPMENT_REPOSITORY,
      manifest: MANIFEST,
      changelog: CHANGELOG_WITH_ENTRY,
      fetchImpl,
    });

    expect({ outcome: decision.outcome, calls: fetchImpl.mock.calls.length }).toEqual({ outcome: 'skip', calls: 0 });
  });

  it('fails in the public repository when the query throws', async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new TypeError('fetch failed');
    };

    const decision = await evaluatePublish({
      repository: PUBLIC_REPOSITORY,
      manifest: MANIFEST,
      changelog: CHANGELOG_WITH_ENTRY,
      fetchImpl,
    });

    expect(decision.outcome).toBe('fail');
  });
});

describe('changelog heading', () => {
  it('finds a heading with the version and a date', () => {
    expect(hasChangelogEntry('# Changelog\n\n## [1.0.0] - 2026-10-01\n', '1.0.0')).toBe(true);
  });

  it.each([
    { label: 'a heading for a version with a suffix', changelog: '## [1.0.0-beta] - 2026-10-01' },
    { label: 'a heading one level deeper', changelog: '### [1.0.0] - 2026-10-01' },
    { label: 'a version in the body text', changelog: '- Links to [1.0.0] in the text.' },
  ])('does not find $label', ({ changelog }) => {
    expect(hasChangelogEntry(changelog, '1.0.0')).toBe(false);
  });
});

describe('version comparison', () => {
  it('compares each part as a number, so 1.10.0 is newer than 1.9.0', () => {
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
  });

  it('treats the same version as equal', () => {
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
  });
});

describe('public repository check', () => {
  it.each([
    { label: 'the letter case differs', repository: 'ymmy833y/agentic-html-visual-editor', url: 'https://github.com/Ymmy833y/Agentic-HTML-Visual-Editor.git' },
    { label: 'the URL has no .git', repository: PUBLIC_REPOSITORY, url: 'https://github.com/Ymmy833y/Agentic-HTML-Visual-Editor' },
    { label: 'the URL is in the git+https form', repository: PUBLIC_REPOSITORY, url: 'git+https://github.com/Ymmy833y/Agentic-HTML-Visual-Editor.git' },
  ])('recognizes the public repository when $label', ({ repository, url }) => {
    expect(isPublicRepository(repository, url)).toBe(true);
  });

  it('does not take a repository with another name for the public repository', () => {
    expect(isPublicRepository(DEVELOPMENT_REPOSITORY, 'https://github.com/Ymmy833y/Agentic-HTML-Visual-Editor.git')).toBe(false);
  });
});

describe('fetching the published version', () => {
  it('returns the version that the response holds', async () => {
    const fetchImpl = respondWith({ results: [{ extensions: [{ versions: [{ version: '0.1.12' }] }] }] });

    await expect(fetchPublishedVersion('YuyaMiyamoto.agentic-html-visual-editor', fetchImpl)).resolves.toEqual({
      kind: 'found',
      version: '0.1.12',
    });
  });

  it('returns none for a response with no extensions', async () => {
    const fetchImpl = respondWith({ results: [{ extensions: [] }] });

    await expect(fetchPublishedVersion('YuyaMiyamoto.agentic-html-visual-editor', fetchImpl)).resolves.toEqual({
      kind: 'none',
    });
  });

  it.each([
    { label: 'HTTP 500', fetchImpl: respondWith({ message: 'Internal Server Error' }, 500) },
    {
      label: 'a network failure',
      fetchImpl: (async () => {
        throw new TypeError('fetch failed');
      }) satisfies typeof fetch,
    },
    { label: 'a response of the wrong shape', fetchImpl: respondWith({ count: 0 }) },
  ])('throws on $label', async ({ fetchImpl }) => {
    await expect(fetchPublishedVersion('YuyaMiyamoto.agentic-html-visual-editor', fetchImpl)).rejects.toThrow();
  });
});
