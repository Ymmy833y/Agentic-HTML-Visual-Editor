// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { MESSAGE_KEYS } from '../../common/index';
import englishMessages from '../../messages/messages.en.json';

describe('English message resource', () => {
  it('contains a message for every key', () => {
    const missingKeys = MESSAGE_KEYS.filter(
      (key) => !Object.prototype.hasOwnProperty.call(englishMessages, key),
    );

    expect(missingKeys).toEqual([]);
  });

  it('has every backup, protection, and recovery notification body key and every recovery and save action key in the resource', () => {
    const backupKeys = MESSAGE_KEYS.filter((key) => /^(backup|protection|recovery)\./.test(key));

    expect(backupKeys).toEqual(expect.arrayContaining(['recovery.recover', 'recovery.saveAs']));
    expect(backupKeys.filter((key) => typeof Reflect.get(englishMessages, key) !== 'string')).toEqual([]);
  });

  it('has every added restore notification, action, and failure dialog key in the resource', () => {
    const restoreKeys = MESSAGE_KEYS.filter((key) => /^restore(Failure)?\./.test(key));

    expect(restoreKeys).toEqual(expect.arrayContaining(['restore.retry', 'restore.discard']));
    expect(restoreKeys.filter((key) => typeof Reflect.get(englishMessages, key) !== 'string')).toEqual([]);
  });

  it('has no location placeholder in the restore failure message that does not show the backup location', () => {
    const withLocation = Reflect.get(englishMessages, 'restore.failed.message');
    const withoutLocation = Reflect.get(englishMessages, 'restore.failedWithoutLocation.message');

    expect(withLocation).toContain('{location}');
    expect(withoutLocation).not.toContain('{location}');
  });

  it('has a message in the English resource for each of the five toolbar keys that were added', () => {
    const toolbarKeys = MESSAGE_KEYS.filter((key) => key.startsWith('toolbar.'));

    expect(toolbarKeys).toEqual(expect.arrayContaining([
      'toolbar.bold',
      'toolbar.italic',
      'toolbar.strikethrough',
      'toolbar.inlineCode',
      'toolbar.clearFormatting',
    ]));
    expect(toolbarKeys.filter((key) => typeof Reflect.get(englishMessages, key) !== 'string'))
      .toEqual([]);
  });

  it('gives the twelve block format keys that were added a message in the English resource', () => {
    const blockKeys = MESSAGE_KEYS.filter(
      (key) => /^blockType\./.test(key)
        || key === 'toolbar.blockType'
        || key === 'toolbar.codeBlock'
        || key === 'toolbar.horizontalRule',
    );

    expect(blockKeys).toHaveLength(12);
    expect(blockKeys.filter((key) => typeof Reflect.get(englishMessages, key) !== 'string'))
      .toEqual([]);
  });

  it('gives the four added keys an English message, with different names for the fixed toolbar and the floating menu', () => {
    const keys = ['toolbar.name', 'floatingMenu.name', 'editorRoot.name', 'toolbar.unsavedChanges'];
    const messages = keys.map((key) => Reflect.get(englishMessages, key));

    expect([
      MESSAGE_KEYS.filter((key) => keys.includes(key)).length,
      messages.every((message) => typeof message === 'string' && message.length > 0),
      messages[0] !== messages[1],
    ]).toEqual([4, true, true]);
  });

  it('the 2 added list keys have messages in the English resource', () => {
    const keys = ['toolbar.bulletList', 'toolbar.orderedList'];

    expect([
      MESSAGE_KEYS.filter((key) => keys.includes(key)).length,
      keys.every((key) => typeof Reflect.get(englishMessages, key) === 'string'),
    ]).toEqual([2, true]);
  });

  it('the 6 added table keys have messages in the English resource', () => {
    const keys = [
      'toolbar.table',
      'tablePicker.grid',
      'tablePicker.size',
      'tablePicker.rows',
      'tablePicker.columns',
      'tablePicker.insert',
    ];

    expect([
      MESSAGE_KEYS.filter((key) => keys.includes(key)).length,
      keys.every((key) => typeof Reflect.get(englishMessages, key) === 'string'),
    ]).toEqual([6, true]);
  });

  it('gives the five added link notification keys a message in the English resource, none with a placeholder', () => {
    const keys = [
      'relativeLink.unresolvable.message',
      'relativeLink.outsideScope.message',
      'relativeLink.notFound.message',
      'relativeLink.notFile.message',
      'relativeLink.openFailed.message',
    ];
    const messages = keys.map((key) => Reflect.get(englishMessages, key));

    // Check that no `{name}` form exists, so there is no way to insert document-derived values into the notification
    // message.
    expect([
      MESSAGE_KEYS.filter((key) => keys.includes(key)).length,
      messages.every((message) => typeof message === 'string' && message.length > 0 && !/\{[^{}]+\}/.test(message)),
    ]).toEqual([5, true]);
  });

  it('gives the 12 link editing and following keys a message in the English resource', () => {
    const keys = [
      'toolbar.link',
      'linkDialog.insertTitle',
      'linkDialog.editTitle',
      'linkDialog.url',
      'linkDialog.insert',
      'linkDialog.update',
      'linkDialog.cancel',
      'linkDialog.remove',
      'linkDialog.urlRequired',
      'linkDialog.urlUnsafe',
      'linkFollow.hint.mac',
      'linkFollow.hint.other',
    ];

    expect([
      MESSAGE_KEYS.filter((key) => keys.includes(key)).length,
      keys.every((key) => typeof Reflect.get(englishMessages, key) === 'string'),
    ]).toEqual([12, true]);
  });

  it('has messages in the English resource for the 15 image insertion and editing keys', () => {
    const keys = [
      'toolbar.image',
      'imageDialog.title',
      'imageDialog.editTitle',
      'imageDialog.source',
      'imageDialog.alt',
      'imageDialog.width',
      'imageDialog.height',
      'imageDialog.insert',
      'imageDialog.update',
      'imageDialog.cancel',
      'imageDialog.sourceRequired',
      'imageDialog.sourceUnsafe',
      'imageDialog.sourceInvalid',
      'imageDialog.widthInvalid',
      'imageDialog.heightInvalid',
    ];

    expect([
      MESSAGE_KEYS.filter((key) => keys.includes(key)).length,
      keys.every((key) => typeof Reflect.get(englishMessages, key) === 'string'),
    ]).toEqual([15, true]);
  });

  it('gives the four Copy as HTML keys a message in the English resource', () => {
    const keys = [
      'toolbar.copyAsHtml',
      'copyAsHtml.noTarget.message',
      'copyAsHtml.copied',
      'copyAsHtml.failed.message',
    ];

    expect([
      MESSAGE_KEYS.filter((key) => keys.includes(key)).length,
      keys.every((key) => typeof Reflect.get(englishMessages, key) === 'string'),
    ]).toEqual([4, true]);
  });

  it('has English messages for the 9 in-document search keys', () => {
    const keys = [
      'search.name',
      'search.field',
      'search.count',
      'search.noResults',
      'search.matchCase',
      'search.wholeWord',
      'search.previous',
      'search.next',
      'search.close',
    ];

    expect([
      MESSAGE_KEYS.filter((key) => keys.includes(key)).length,
      keys.every((key) => typeof Reflect.get(englishMessages, key) === 'string'),
    ]).toEqual([9, true]);
  });

  it('gives the nine diagram keys a message in the English resource', () => {
    const keys = [
      'toolbar.diagram',
      'diagram.renderError',
      'diagram.empty',
      'diagramDialog.title',
      'diagramDialog.source',
      'diagramDialog.save',
      'diagramDialog.cancel',
      'diagramDialog.delete',
      'diagramDialog.sourceRequired',
    ];

    expect([
      MESSAGE_KEYS.filter((key) => keys.includes(key)).length,
      keys.every((key) => typeof Reflect.get(englishMessages, key) === 'string'),
    ]).toEqual([9, true]);
  });

  it('has English messages for the 8 sidebar keys', () => {
    const keys = [
      'toolbar.sidebar',
      'sidebar.name',
      'sidebar.headings',
      'sidebar.comments',
      'sidebar.noHeadings',
      'sidebar.noComments',
      'sidebar.emptyText',
      'sidebar.resolved',
    ];

    expect([
      MESSAGE_KEYS.filter((key) => keys.includes(key)).length,
      keys.every((key) => typeof Reflect.get(englishMessages, key) === 'string'),
    ]).toEqual([8, true]);
  });

  it('has English messages for the 2 code block copy keys', () => {
    const keys = [
      'codeBlockCopy.name',
      'codeBlockCopy.failed.message',
    ];

    expect([
      MESSAGE_KEYS.filter((key) => keys.includes(key)).length,
      keys.every((key) => typeof Reflect.get(englishMessages, key) === 'string'),
    ]).toEqual([2, true]);
  });

  it('has English messages for the 3 diagram zoom keys', () => {
    const keys = [
      'diagramZoom.zoomIn',
      'diagramZoom.zoomOut',
      'diagramZoom.reset',
    ];

    expect([
      MESSAGE_KEYS.filter((key) => keys.includes(key)).length,
      keys.every((key) => typeof Reflect.get(englishMessages, key) === 'string'),
    ]).toEqual([3, true]);
  });

  it('contains no keys that are not defined', () => {
    const definedKeys = new Set<string>(MESSAGE_KEYS);
    const extraKeys = Object.keys(englishMessages).filter((key) => !definedKeys.has(key));

    expect(extraKeys).toEqual([]);
  });
});
