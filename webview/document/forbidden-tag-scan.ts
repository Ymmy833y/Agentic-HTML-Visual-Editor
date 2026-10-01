import { FORBIDDEN_TAG_NAMES } from '../../common/index';

/**
 * Traverses descendant elements and finds the first forbidden tag.
 *
 * @param parent Parent whose children are traversed.
 * @returns The matched lowercase tag name, or `undefined` when none is found.
 */
function findInChildren(parent: ParentNode): string | undefined {
  for (const child of parent.children) {
    const tagName = child.tagName.toLowerCase();
    if (FORBIDDEN_TAG_NAMES.has(tagName)) {
      return tagName;
    }

    // A `<template>` stores its content in a separate tree rather than as child nodes, so traverse it
    // explicitly to avoid missing forbidden tags inside.
    const found = findInChildren(child instanceof HTMLTemplateElement ? child.content : child);
    if (found !== undefined) {
      return found;
    }
  }

  return undefined;
}

/**
 * Finds a forbidden tag in a tree.
 *
 * @param root Parsed tree.
 * @returns The matched lowercase tag name, or `undefined` when none is found.
 */
export function findForbiddenTag(root: DocumentFragment): string | undefined {
  return findInChildren(root);
}
