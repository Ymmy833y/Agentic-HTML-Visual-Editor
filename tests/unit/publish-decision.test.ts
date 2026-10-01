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

// 公開リポジトリを指す package.json。
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
 * 決まった応答を返す fetch を作る。
 *
 * @param body 応答の本文として JSON にする値。
 * @param status HTTP の状態コード。
 * @returns 代わりの fetch。
 */
function respondWith(body: unknown, status = 200): typeof fetch {
  return async () => new Response(JSON.stringify(body), { status });
}

describe('公開の判定', () => {
  it('版が公開済みより新しく、変更履歴に項目があると公開すると判定する', () => {
    const decision = decidePublish({
      version: '1.0.0',
      published: { kind: 'found', version: '0.1.12' },
      changelog: CHANGELOG_WITH_ENTRY,
    });

    expect(decision.outcome).toBe('publish');
  });

  it('版が公開済みと同じなら公開不要と判定する', () => {
    const decision = decidePublish({
      version: '1.0.0',
      published: { kind: 'found', version: '1.0.0' },
      changelog: CHANGELOG_WITH_ENTRY,
    });

    expect(decision.outcome).toBe('skip');
  });

  it('版が公開済みより古いと公開不要と判定し、理由に 2 つの版が入る', () => {
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

  it('未公開で変更履歴に項目があると公開すると判定する', () => {
    const decision = decidePublish({
      version: '1.0.0',
      published: { kind: 'none' },
      changelog: CHANGELOG_WITH_ENTRY,
    });

    expect(decision.outcome).toBe('publish');
  });

  it('版が公開済みより新しくても、変更履歴に項目が無ければ失敗と判定する', () => {
    const decision = decidePublish({
      version: '1.0.0',
      published: { kind: 'found', version: '0.1.12' },
      changelog: CHANGELOG_WITHOUT_ENTRY,
    });

    expect(decision.outcome).toBe('fail');
  });

  it.each([
    { label: '公開済みの版がある', published: { kind: 'found', version: '0.1.12' } as const },
    { label: '未公開', published: { kind: 'none' } as const },
    { label: '取得に失敗した', published: { kind: 'error', message: '通信の失敗' } as const },
  ])('接尾辞の付いた版は、$label ときも失敗と判定する', ({ published }) => {
    const decision = decidePublish({
      version: '1.0.0-beta.1',
      published,
      changelog: '## [1.0.0-beta.1] - 2026-10-01',
    });

    expect(decision.outcome).toBe('fail');
  });

  it('公開済みの版の取得に失敗していると、公開せずに失敗と判定する', () => {
    const decision = decidePublish({
      version: '1.0.0',
      published: { kind: 'error', message: '通信の失敗' },
      changelog: CHANGELOG_WITH_ENTRY,
    });

    expect(decision.outcome).toBe('fail');
  });
});

describe('実行中のリポジトリを含めた公開の判定', () => {
  it('開発リポジトリの名前では、Marketplace へ照会せずに公開不要を返す', async () => {
    const fetchImpl = vi.fn(respondWith({ results: [{ extensions: [] }] }));

    const decision = await evaluatePublish({
      repository: DEVELOPMENT_REPOSITORY,
      manifest: MANIFEST,
      changelog: CHANGELOG_WITH_ENTRY,
      fetchImpl,
    });

    expect({ outcome: decision.outcome, calls: fetchImpl.mock.calls.length }).toEqual({ outcome: 'skip', calls: 0 });
  });

  it('公開リポジトリで照会が例外を投げると、失敗を返す', async () => {
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

describe('変更履歴の見出し', () => {
  it('版と日付の見出しを見つける', () => {
    expect(hasChangelogEntry('# Changelog\n\n## [1.0.0] - 2026-10-01\n', '1.0.0')).toBe(true);
  });

  it.each([
    { label: '接尾辞の付いた版の見出し', changelog: '## [1.0.0-beta] - 2026-10-01' },
    { label: '1 段深い見出し', changelog: '### [1.0.0] - 2026-10-01' },
    { label: '本文の中の版', changelog: '- Links to [1.0.0] in the text.' },
  ])('$label は見つけない', ({ changelog }) => {
    expect(hasChangelogEntry(changelog, '1.0.0')).toBe(false);
  });
});

describe('版の比較', () => {
  it('各部分を数として比べ、1.10.0 を 1.9.0 より新しいとする', () => {
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
  });

  it('同じ版を等しいとする', () => {
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
  });
});

describe('公開リポジトリの判定', () => {
  it.each([
    { label: '大文字と小文字が違う', repository: 'ymmy833y/agentic-html-visual-editor', url: 'https://github.com/Ymmy833y/Agentic-HTML-Visual-Editor.git' },
    { label: '.git が無い', repository: PUBLIC_REPOSITORY, url: 'https://github.com/Ymmy833y/Agentic-HTML-Visual-Editor' },
    { label: 'git+https の形', repository: PUBLIC_REPOSITORY, url: 'git+https://github.com/Ymmy833y/Agentic-HTML-Visual-Editor.git' },
  ])('$label ときも公開リポジトリと判定する', ({ repository, url }) => {
    expect(isPublicRepository(repository, url)).toBe(true);
  });

  it('名前の異なるリポジトリは公開リポジトリと判定しない', () => {
    expect(isPublicRepository(DEVELOPMENT_REPOSITORY, 'https://github.com/Ymmy833y/Agentic-HTML-Visual-Editor.git')).toBe(false);
  });
});

describe('公開済みの版の取得', () => {
  it('応答に版が含まれていれば、その版を返す', async () => {
    const fetchImpl = respondWith({ results: [{ extensions: [{ versions: [{ version: '0.1.12' }] }] }] });

    await expect(fetchPublishedVersion('YuyaMiyamoto.agentic-html-visual-editor', fetchImpl)).resolves.toEqual({
      kind: 'found',
      version: '0.1.12',
    });
  });

  it('拡張が 0 件の応答では未公開を返す', async () => {
    const fetchImpl = respondWith({ results: [{ extensions: [] }] });

    await expect(fetchPublishedVersion('YuyaMiyamoto.agentic-html-visual-editor', fetchImpl)).resolves.toEqual({
      kind: 'none',
    });
  });

  it.each([
    { label: 'HTTP 500', fetchImpl: respondWith({ message: 'Internal Server Error' }, 500) },
    {
      label: '通信の失敗',
      fetchImpl: (async () => {
        throw new TypeError('fetch failed');
      }) satisfies typeof fetch,
    },
    { label: '形の合わない応答', fetchImpl: respondWith({ count: 0 }) },
  ])('$label では例外を投げる', async ({ fetchImpl }) => {
    await expect(fetchPublishedVersion('YuyaMiyamoto.agentic-html-visual-editor', fetchImpl)).rejects.toThrow();
  });
});
