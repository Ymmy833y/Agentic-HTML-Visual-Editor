import * as assert from 'node:assert';
import type * as vscode from 'vscode';
import { readBackupFile, writeBackupFile } from '../../../src/editor/backupFile';
import { deleteIfExists, fileExists, fixtureUri, writeFileText } from './helpers';

// Characterization tests for reading and writing the hot-exit backup file.

const BACKUP_DIR = 'backup-file-test';

function backupUri(name: string): vscode.Uri {
  return fixtureUri(`${BACKUP_DIR}/${name}`);
}

suite('Backup file persistence', () => {
  teardown(async () => {
    await deleteIfExists(fixtureUri(BACKUP_DIR));
  });

  test('round-trips the unsaved backup payload', async () => {
    const destination = backupUri('roundtrip.json');
    const backup = {
      baseHtml: '<p>on disk</p>\n',
      html: '<p>edited in the view</p>\n',
    };

    await writeBackupFile(destination, backup);
    const restored = await readBackupFile(destination);

    assert.deepStrictEqual(restored, backup);
  });

  test('creates the destination directory when it does not exist', async () => {
    const destination = backupUri('nested/deeper/backup.json');
    assert.strictEqual(
      await fileExists(fixtureUri(`${BACKUP_DIR}/nested`)),
      false,
      'the precondition is that the parent directory is missing',
    );

    await writeBackupFile(destination, { baseHtml: 'a', html: 'b' });

    assert.strictEqual(await fileExists(destination), true, 'the backup file should be written');
  });

  test('preserves content that would break as a bare string (CRLF, quotes, unicode)', async () => {
    const destination = backupUri('tricky.json');
    const backup = {
      baseHtml: '<p>"quoted"</p>\r\n<p>タブ\tと改行</p>\r\n',
      html: '<p>絵文字 \u{1F600} と backslash \\ </p>\r\n',
    };

    await writeBackupFile(destination, backup);

    assert.deepStrictEqual(await readBackupFile(destination), backup);
  });

  test('returns undefined when the backup file does not exist', async () => {
    assert.strictEqual(await readBackupFile(backupUri('absent.json')), undefined);
  });

  test('returns undefined when the backup file is not valid JSON', async () => {
    const destination = backupUri('malformed.json');
    await writeBackupFile(destination, { baseHtml: 'a', html: 'b' });
    await writeFileText(destination, '{ this is not json');

    assert.strictEqual(await readBackupFile(destination), undefined);
  });

  test('returns undefined when the payload has the wrong shape', async () => {
    const cases: Array<[string, string]> = [
      ['null.json', 'null'],
      ['array.json', '["baseHtml", "html"]'],
      ['missing-html.json', JSON.stringify({ baseHtml: 'a' })],
      ['missing-base.json', JSON.stringify({ html: 'b' })],
      ['non-string.json', JSON.stringify({ baseHtml: 'a', html: 42 })],
    ];

    for (const [name, content] of cases) {
      const destination = backupUri(name);
      await writeBackupFile(destination, { baseHtml: 'seed', html: 'seed' });
      await writeFileText(destination, content);
      assert.strictEqual(
        await readBackupFile(destination),
        undefined,
        `${name} should not restore`,
      );
    }
  });

  test('narrows the payload to the two known fields', async () => {
    const destination = backupUri('extra.json');
    await writeBackupFile(destination, { baseHtml: 'seed', html: 'seed' });
    await writeFileText(
      destination,
      JSON.stringify({ baseHtml: 'a', html: 'b', selection: { anchor: 1 } }),
    );

    assert.deepStrictEqual(await readBackupFile(destination), { baseHtml: 'a', html: 'b' });
  });
});
