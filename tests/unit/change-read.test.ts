import { describe, expect, it } from 'vitest';

import {
  findChangeAt,
  isChangeInTree,
  isInlineChange,
  readChangeAuthor,
  readChangeHead,
  readChangeKind,
  readChanges,
  readReplacementPartner,
} from '../../webview/editing/change-read';
import { createRoot, readChildText, readElement } from './helpers/format-dom';

/**
 * Describes marks as `name#id` so that the order and the identity of each can be compared in one go.
 *
 * @param elements The marks.
 */
function describeMarks(elements: readonly Element[]): string[] {
  return elements.map((element) => `${element.localName}#${element.id}`);
}

describe('reading change marks', () => {
  it('returns ins, del and the elements with data-change in document order, counting nested marks one each', () => {
    const root = createRoot(
      '<p><ins id="a">x<del id="b">y</del></ins></p>'
      + '<ul><li id="c" data-change="del">z</li></ul>'
      + '<table><tbody><tr id="d" data-change="ins"><td>w</td></tr></tbody></table>'
      + '<p id="e" data-change="del"><ins id="f">v</ins></p>',
    );

    expect(describeMarks(readChanges(root))).toEqual(['ins#a', 'del#b', 'li#c', 'tr#d', 'p#e', 'ins#f']);
  });

  it('leaves out marks inside entries and elements whose data-change is neither ins nor del', () => {
    const root = createRoot(
      '<p><comment id="c">t<comment-body><ins id="hidden">n</ins></comment-body></comment></p>'
      + '<p id="other" data-change="INS">u</p><p id="empty" data-change="">v</p>',
    );

    expect(readChanges(root)).toEqual([]);
  });

  it('does not read data-change on a comment, its body or a reply as a mark', () => {
    const root = createRoot(
      '<p><comment id="c" data-change="ins">t<comment-body id="b" data-change="ins">n</comment-body>'
      + '<comment-reply id="r" data-change="ins" data-author="ai">m</comment-reply></comment></p>',
    );

    expect([
      readChanges(root),
      ['#c', '#b', '#r'].map((selector) => readChangeKind(readElement(root, selector))),
    ]).toEqual([[], [undefined, undefined, undefined]]);
  });

  it('reads the kind from the element name of an inline mark and from the attribute of any other element', () => {
    const root = createRoot('<ins id="i" data-change="del">a</ins><li id="l" data-change="del">b</li><span id="s">c</span>');

    expect([
      readChangeKind(readElement(root, '#i')),
      readChangeKind(readElement(root, '#l')),
      readChangeKind(readElement(root, '#s')),
      readChangeKind(readChildText(readElement(root, '#s'), 0)),
    ]).toEqual(['ins', 'del', undefined, undefined]);
  });

  it('tells an inline mark apart from an element that carries the kind', () => {
    const root = createRoot('<del id="d">a</del><table><tbody><tr id="r" data-change="del"><td>b</td></tr></tbody></table>');

    expect([isInlineChange(readElement(root, '#d')), isInlineChange(readElement(root, '#r'))]).toEqual([true, false]);
  });

  it('finds the nearest mark around a position, and none outside a mark or outside the root', () => {
    const root = createRoot('<p>a<ins id="outer">b<del id="inner">c</del></ins>d</p>');
    const inner = readElement(root, '#inner');
    const outer = readElement(root, '#outer');

    expect([
      findChangeAt(readChildText(inner, 0), root),
      findChangeAt(readChildText(outer, 0), root),
      findChangeAt(inner, root),
      findChangeAt(readChildText(readElement(root, 'p'), 0), root),
      findChangeAt(root, root),
      findChangeAt(document.createElement('ins'), root),
    ]).toEqual([inner, outer, inner, undefined, undefined, undefined]);
  });

  it('does not find a mark through an entry', () => {
    const root = createRoot('<p><ins id="i">a<comment id="c">b<comment-body id="n">note</comment-body></comment></ins></p>');

    expect(findChangeAt(readChildText(readElement(root, '#n'), 0), root)).toBeUndefined();
  });

  it('counts a mark as the AI side only when its author is exactly ai', () => {
    const root = createRoot(
      '<ins id="ai" data-author="ai">a</ins><ins id="upper" data-author="AI">b</ins>'
      + '<ins id="human" data-author="human">c</ins><ins id="none">d</ins>',
    );

    expect(['#ai', '#upper', '#human', '#none'].map((selector) => readChangeAuthor(readElement(root, selector))))
      .toEqual(['ai', 'human', 'human', 'human']);
  });

  it('counts a mark as in the tree only while it is connected inside the root', () => {
    const root = createRoot('<p><ins id="i">a</ins></p>');
    document.body.replaceChildren(root);
    const mark = readElement(root, '#i');
    const detached = document.createElement('ins');

    const before = isChangeInTree(root, mark);
    mark.remove();

    expect([before, isChangeInTree(root, mark), isChangeInTree(root, detached)]).toEqual([true, false, false]);
  });
});

describe('reading replacement pairs', () => {
  it('pairs a deletion with the insertion right after it, across HTML whitespace alone, and makes the deletion the head of both', () => {
    const root = createRoot(
      '<p><del id="d">a</del><ins id="i">b</ins></p>'
      + '<ul>\n<li id="dl" data-change="del" data-author="ai">c</li>\n<li id="il" data-change="ins" data-author="ai">d</li>\n</ul>'
      + '<p><del id="ds">e</del> <ins id="is">f</ins></p>',
    );
    const [deletion, insertion, deletedItem, insertedItem, spacedDeletion, spacedInsertion] = ['#d', '#i', '#dl', '#il', '#ds', '#is']
      .map((selector) => readElement(root, selector));

    expect([
      readReplacementPartner(deletion),
      readReplacementPartner(insertion),
      readReplacementPartner(deletedItem),
      readReplacementPartner(insertedItem),
      readReplacementPartner(spacedDeletion),
      readChangeHead(deletion),
      readChangeHead(insertion),
      readChangeHead(insertedItem),
      readChangeHead(spacedInsertion),
    ]).toEqual([insertion, deletion, insertedItem, deletedItem, spacedInsertion, deletion, deletion, deletedItem, spacedDeletion]);
  });

  it('pairs nothing when the author sides differ, text lies between (an NBSP or an ideographic space too), the insertion comes first, the halves differ in form, or one nests in the other', () => {
    const root = createRoot(
      '<p><del id="a1" data-author="ai">a</del><ins id="a2" data-author="human">b</ins></p>'
      + '<p><del id="b1">a</del> x <ins id="b2">b</ins></p>'
      + '<p><del id="f1">a</del>&nbsp;<ins id="f2">b</ins></p>'
      + '<p><del id="g1">a</del>\u3000<ins id="g2">b</ins></p>'
      + '<p><ins id="c1">a</ins><del id="c2">b</del></p>'
      + '<div><del id="d1">a</del><p id="d2" data-change="ins">b</p></div>'
      + '<p><del id="e1">a<ins id="e2">b</ins></del></p>',
    );

    expect(['#a1', '#a2', '#b1', '#b2', '#f1', '#f2', '#g1', '#g2', '#c1', '#c2', '#d1', '#d2', '#e1', '#e2'].map((selector) => {
      const mark = readElement(root, selector);
      return [readReplacementPartner(mark), readChangeHead(mark) === mark];
    })).toEqual(Array.from({ length: 14 }, () => [undefined, true]));
  });
});
